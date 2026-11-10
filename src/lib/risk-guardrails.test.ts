import { describe, expect, it } from "vitest";
import { demoFixtures } from "@/lib/ai/demo";
import {
  DECISION_PATTERNS,
  PROTECTED_PATTERNS,
  allowedNumbers,
  applyGuardrails,
  fallbackData,
  hasUnverifiedNumber,
  textViolations,
} from "./risk-guardrails";
import { type RiskInput, assessRisk } from "./risk-rules";
import { type RiskModelOutput, riskSummarySchema } from "./risk-schema";

const input: RiskInput = {
  amountCents: 1_200_000,
  termMonths: 36,
  employmentStatus: "employed",
  monthsEmployed: 8,
  annualIncomeCents: 4_800_000,
  monthlyHousingCents: 80_000,
  monthlyDebtCents: 70_000,
  creditBand: "good",
  documentKinds: ["id", "pay_stub"],
};
const assessment = assessRisk(input);
const allowed = allowedNumbers(assessment);
const hits = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

const output = (over: Partial<RiskModelOutput>): RiskModelOutput => ({
  summary: "Several rules apply; see the reasons.",
  strengths: [],
  concerns: [],
  questionsForApplicant: [],
  ...over,
});

describe("decision-language filter", () => {
  it.each([
    "I recommend approval",
    "This loan should be funded",
    "likely to default",
    "Decline this one",
    "Rejected on income",
    "The applicant is eligible",
    "Application denied",
    "Strong candidate",
    "we could turn them down",
  ])("catches %s", (text) => expect(hits(DECISION_PATTERNS, text)).toBe(true));

  it.each([
    "Debt-to-income is 47.9% with the new payment.",
    "Stated income hasn't been checked against the documents.",
    "Ask for the two most recent pay stubs.",
  ])("lets %s through", (text) => expect(hits(DECISION_PATTERNS, text)).toBe(false));
});

describe("protected-characteristics filter", () => {
  it.each([
    "appears older",
    "applicant is married",
    "young borrower",
    "race or ethnicity",
    "religious",
    "national origin",
    "gender",
    "pregnant",
    "disabled",
    "lives in a rural zip code",
    "bad neighborhood",
    "receives public assistance",
    "has three children",
  ])("catches %s", (text) => expect(hits(PROTECTED_PATTERNS, text)).toBe(true));

  it.each([
    "The percentage of income is above the threshold",
    "average payment relative to income",
    "managed expenses",
    "Employment status is retired but income is stated",
    "months employed is under the limit",
  ])("lets %s through", (text) => expect(hits(PROTECTED_PATTERNS, text)).toBe(false));
});

describe("number guardrail", () => {
  it("accepts metrics within half a unit and numbers printed in the rule reasons", () => {
    expect(hasUnverifiedNumber("DTI is 48%", allowed)).toBe(false);
    expect(hasUnverifiedNumber("The new payment is about $415", allowed)).toBe(false);
    expect(hasUnverifiedNumber("Income is $4,000 a month", allowed)).toBe(false);
    expect(hasUnverifiedNumber("8 months at the current job, under 12 months", allowed)).toBe(false);
    expect(hasUnverifiedNumber("above the 43% limit", allowed)).toBe(false);
  });

  it("rejects numbers the rules did not produce", () => {
    expect(hasUnverifiedNumber("DTI is 61%", allowed)).toBe(true);
    expect(hasUnverifiedNumber("Income is $5,000 a month", allowed)).toBe(true);
    expect(hasUnverifiedNumber("DTI is 49%", allowed)).toBe(true);
  });

  it("rejects spelled-out numbers in claims, but not in questions", () => {
    expect(hasUnverifiedNumber("Forty-eight percent of income", allowed)).toBe(true);
    expect(textViolations("Can you provide your two latest pay stubs?", allowed, { words: false })).toEqual([]);
  });
});

describe("applyGuardrails", () => {
  it("keeps a clean answer", () => {
    const clean = output({
      concerns: [{ flag: "DTI_HIGH", text: "DTI is 48% with the new payment.", evidence: ["dti", "new_payment"] }],
      strengths: [{ text: "Documents are on file.", evidence: ["documents"] }],
      questionsForApplicant: ["Can you explain the recent job change?"],
    });
    const result = applyGuardrails(clean, assessment);
    expect(result.fallback).toBe(false);
    expect(result.codes).toEqual([]);
    expect(result.data.concerns).toHaveLength(1);
    expect(result.data.strengths).toHaveLength(1);
  });

  it("rejects the whole answer for a protected characteristic or decision language in the summary", () => {
    const result = applyGuardrails(output({ summary: "Applicant appears older and married; recommend decline" }), assessment);
    expect(result.fallback).toBe(true);
    expect(result.codes).toEqual(expect.arrayContaining(["protected_characteristic", "decision_language"]));
    expect(result.data).toEqual(fallbackData(assessment));
    expect(result.data.concerns.map((c) => c.flag)).toEqual(assessment.flags.map((f) => f.code));
  });

  it("drops invented flags and replaces a wrong number with the rule's reason", () => {
    const result = applyGuardrails(
      output({
        concerns: [
          { flag: "FRAUD_SUSPECTED", text: "Possible fraud.", evidence: ["documents"] },
          { flag: "DTI_HIGH", text: "DTI is 61%", evidence: ["dti"] },
        ],
      }),
      assessment,
    );
    expect(result.data.concerns).toEqual([
      { flag: "DTI_HIGH", text: assessment.flags.find((f) => f.code === "DTI_HIGH")!.reason, evidence: ["dti"] },
    ]);
    expect(result.codes).toEqual(expect.arrayContaining(["unknown_flag", "number_mismatch"]));
  });

  it("drops a concern for a flag the rules did not raise, and duplicates", () => {
    const result = applyGuardrails(
      output({
        concerns: [
          { flag: "CREDIT_BAND_POOR", text: "Credit is poor.", evidence: ["credit_band"] },
          { flag: "DTI_HIGH", text: "Debt load is high.", evidence: ["dti"] },
          { flag: "DTI_HIGH", text: "Debt load is high again.", evidence: ["dti"] },
        ],
      }),
      assessment,
    );
    expect(result.data.concerns.map((c) => c.flag)).toEqual(["DTI_HIGH"]);
    expect(result.codes).toEqual(expect.arrayContaining(["unknown_flag", "duplicate_flag"]));
  });

  it("corrects evidence to metrics the rule reads", () => {
    const result = applyGuardrails(
      output({ concerns: [{ flag: "SHORT_EMPLOYMENT", text: "Short time in the job.", evidence: ["credit_band"] }] }),
      assessment,
    );
    expect(result.data.concerns[0].evidence).toEqual(["months_employed"]);
    expect(result.codes).toContain("evidence_corrected");
  });

  it("drops strengths that cite a metric a rule flags, and strengths or questions with banned words", () => {
    const result = applyGuardrails(
      output({
        strengths: [
          { text: "Debt load is fine.", evidence: ["dti"] },
          { text: "Strong candidate to approve.", evidence: ["documents"] },
          { text: "Documents are on file.", evidence: ["documents"] },
        ],
        questionsForApplicant: ["Are you married?", "Can you share a recent bank statement?"],
      }),
      assessment,
    );
    expect(result.data.strengths).toEqual([{ text: "Documents are on file.", evidence: ["documents"] }]);
    expect(result.data.questionsForApplicant).toEqual(["Can you share a recent bank statement?"]);
    expect(result.codes).toEqual(expect.arrayContaining(["strength_contradicts_flag", "decision_language", "protected_characteristic"]));
  });

  it("replaces only the summary text when it has a wrong number", () => {
    const result = applyGuardrails(output({ summary: "Debt-to-income is 61%." }), assessment);
    expect(result.fallback).toBe(false);
    expect(result.data.summary).toMatch(/rules flagged/);
    expect(result.codes).toEqual(["number_mismatch"]);
  });
});

describe("our own text passes our own filters", () => {
  it("every rule reason and the fallback text is clean, across every flag", () => {
    const everything = assessRisk({
      ...input,
      creditBand: "poor",
      employmentStatus: "unemployed",
      documentKinds: [],
      amountCents: 4_000_000,
    });
    const texts = [...everything.flags.map((f) => f.reason), ...fallbackData(everything).concerns.map((c) => c.text), fallbackData(everything).summary];
    expect(new Set(everything.flags.map((f) => f.code)).size).toBeGreaterThanOrEqual(6);
    for (const text of texts) {
      expect(hits(DECISION_PATTERNS, text), text).toBe(false);
      expect(hits(PROTECTED_PATTERNS, text), text).toBe(false);
    }
  });

  it("the demo fixture matches the schema and passes the guardrails untouched when its flags apply", () => {
    const fixture = riskSummarySchema.parse(demoFixtures["loan-risk-summary"]);
    const result = applyGuardrails(fixture, assessment);
    expect(result.codes).toEqual([]);
    expect(result.fallback).toBe(false);
    expect(result.data.concerns.map((c) => c.flag)).toEqual(["DTI_HIGH", "INCOME_UNVERIFIED"]);
  });
});
