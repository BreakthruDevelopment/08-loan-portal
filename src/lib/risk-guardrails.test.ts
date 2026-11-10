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
    "Confirm the source of funds in the bank statement.",
    "Ask how the applicant plans to address the missing pay stub.",
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
    "Employment status is retired but income is stated",
    "lives on a pension",
    "relies on Social Security",
    "receives SSI",
    "a fixed income",
    "a full-time student",
    "a veteran",
    "military service",
    "the home address is out of state",
  ])("catches %s", (text) => expect(hits(PROTECTED_PATTERNS, text)).toBe(true));

  it.each([
    "The percentage of income is above the threshold",
    "average payment relative to income",
    "managed expenses",
    "months employed is under the limit",
    "Please address the missing document.",
    "The underwriter should be familiar with the pay stub format.",
  ])("lets %s through", (text) => expect(hits(PROTECTED_PATTERNS, text)).toBe(false));
});

describe("eval-1 application", () => {
  it("is the one the adversarial cases below run against", () => {
    expect(assessment.metrics).toMatchObject({ dtiPct: 47.9, ltiPct: 25, assumedAprPct: 14.9, monthsEmployed: 8 });
    expect(assessment.metrics.documents).toMatchObject({ id: 1, pay_stub: 1 });
    expect(assessment.flags.map((f) => f.code)).toEqual(["DTI_HIGH", "SHORT_EMPLOYMENT", "INCOME_UNVERIFIED"]);
  });
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

describe("numbers are matched by unit, not as a bag of numbers", () => {
  it.each([
    "Debt payments take 0.61 of monthly income.",
    "Obligations are 1.4 times the safe level.",
    "DTI is 14.9%.",
    "DTI is 43%.",
    "Monthly income is only $8.",
    "DTI is \uFF16\uFF11%.",
    "about a third of income",
    "twice the limit",
    "a quarter of income",
    "half of income",
    "APR is 47.9%.",
    "The loan is 47.9% of annual income.",
    "Income is 4000 a month.",
    "The new payment is $415.99.",
    "That is 20 months.",
    "Debt-to-income is 36%.",
  ])("rejects %s", (text) => expect(textViolations(text, allowed)).toContain("number_mismatch"));

  it.each([
    "DTI is 47.9%.",
    "DTI is 48%.",
    "Debt-to-income is 47.9% with the estimated new payment of $415.40, above the 43% limit.",
    "DTI is 48% with the new payment, above the 43% limit.",
    "The loan is 25% of annual income.",
    "Loan-to-income is 25.0% and the APR is 14.9%.",
    "DTI is 0.479 of income.",
    "Income is $4,000 a month and the payment is about $415.",
    "8 months in the current job, under 12 months.",
    "Stated income is $4,000.00 a month.",
    "Debt-to-income would be between 36% and 43%.",
  ])("accepts %s", (text) => expect(textViolations(text, allowed)).not.toContain("number_mismatch"));

  it("accepts the numbers in the rules' own reasons", () => {
    for (const flag of assessment.flags) expect(hasUnverifiedNumber(flag.reason, allowed), flag.reason).toBe(false);
    const elevated = assessRisk({ ...input, annualIncomeCents: 5_900_000, monthsEmployed: 36 });
    for (const flag of elevated.flags) expect(hasUnverifiedNumber(flag.reason, allowedNumbers(elevated)), flag.reason).toBe(false);
  });
});

describe("decision and prediction language", () => {
  it.each([
    "I would advise against extending this loan given the debt load.",
    "Overall this file looks acceptable and safe to move forward.",
    "The underwriter can accept this application.",
    "The applicant is unlikely to repay on schedule.",
    "The applicant may default given the debt load.",
    "There is a high risk of default here.",
    "This is a high-risk borrower.",
    "A low-risk applicant overall.",
    "Nothing here should stop a green light.",
    "Not a good fit for this loan amount.",
    "Most lenders would pass on this file.",
    "It would be prudent to refuse.",
    "Low risk overall; nothing stands in the way.",
    "A safe bet for this amount.",
    "Good to go once pay stubs arrive.",
    "I suggest a closer look.",
    "Time to go ahead and sign off.",
    "This could be a case of fraud.",
    "Some documents look suspicious.",
    "The stated income seems dishonest.",
    "This file should be funded.",
    "The bank would fund the loan.",
  ])("rejects %s", (text) => expect(textViolations(text, allowed)).toContain("decision_language"));

  it("normalises look-alike characters before matching", () => {
    expect(textViolations("I recommend app\u200Brov\uFF41l.", allowed)).toContain("decision_language");
    expect(textViolations("\uFF21\uFF50\uFF50\uFF52\uFF4F\uFF56\uFF45 it", allowed)).toContain("decision_language");
  });

  it("drops such strengths, and replaces the summary", () => {
    const strengths = ["Low risk overall; nothing stands in the way.", "A safe bet for this amount.", "Good to go once pay stubs arrive."];
    const result = applyGuardrails(output({ strengths: strengths.map((text) => ({ text, evidence: ["documents"] as ["documents"] })) }), assessment);
    expect(result.data.strengths).toEqual([]);
    expect(result.codes).toContain("decision_language");
    expect(applyGuardrails(output({ summary: "The applicant may default given the debt load." }), assessment).fallback).toBe(true);
  });
});

describe("unrecognised ALL-CAPS tokens", () => {
  it("rejects a code the rules did not raise, accepts raised codes and DTI, LTI, APR", () => {
    expect(textViolations("Flagged as CREDIT_BAND_POOR.", allowed)).toContain("unknown_token");
    expect(textViolations("See FRAUD_SUSPECTED.", allowed)).toContain("unknown_token");
    expect(textViolations("This is VERY HIGH.", allowed)).toContain("unknown_token");
    expect(textViolations("DTI_HIGH applies; DTI and LTI use the APR.", allowed)).not.toContain("unknown_token");
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

  it("drops a strength about a flagged metric even when its evidence is something else", () => {
    const result = applyGuardrails(output({ strengths: [{ text: "Debt load is manageable.", evidence: ["credit_band"] }] }), assessment);
    expect(result.data.strengths).toEqual([]);
    expect(result.codes).toContain("strength_contradicts_flag");
  });

  it.each([
    ["Debt payments are comfortable.", ["credit_band"]],
    ["The new payment is small.", ["lti"]],
    ["Obligations look light.", ["documents"]],
    ["Time in the current job is solid.", ["months_employed"]],
  ] as const)("drops the strength %s (DTI_HIGH and SHORT_EMPLOYMENT raised)", (text, evidence) => {
    const result = applyGuardrails(output({ strengths: [{ text, evidence: [...evidence] }] }), assessment);
    expect(result.data.strengths).toEqual([]);
  });

  it("drops a strength that names a metric outside its evidence", () => {
    const calm = assessRisk({ ...input, amountCents: 800_000, creditBand: "excellent", annualIncomeCents: 10_800_000, monthlyHousingCents: 150_000, monthlyDebtCents: 20_000, monthsEmployed: 72 });
    const ok = applyGuardrails(output({ strengths: [{ text: "Debt-to-income is 22%.", evidence: ["dti"] }] }), calm);
    expect(ok.data.strengths).toHaveLength(1);
    const off = applyGuardrails(output({ strengths: [{ text: "Income is steady.", evidence: ["dti"] }] }), calm);
    expect(off.data.strengths).toEqual([]);
    expect(off.codes).toContain("strength_unsupported");
    const loan = applyGuardrails(output({ strengths: [{ text: "Loan-to-income is low.", evidence: ["dti"] }] }), calm);
    expect(loan.data.strengths).toEqual([]);
  });

  it("drops 'required documents are present' when no ID is on file", () => {
    const noId = assessRisk({ ...input, documentKinds: ["pay_stub"] });
    const result = applyGuardrails(output({ strengths: [{ text: "Required documents are present.", evidence: ["documents"] }] }), noId);
    expect(result.data.strengths).toEqual([]);
    const withId = applyGuardrails(output({ strengths: [{ text: "Required documents are present.", evidence: ["documents"] }] }), assessment);
    expect(withId.data.strengths).toHaveLength(1);
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
