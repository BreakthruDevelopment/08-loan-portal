import { describe, expect, it } from "vitest";
import { fieldsComplete, type ApplicationFieldValues } from "@/lib/loan";
import {
  STEP_IDS,
  buildPatch,
  documentGaps,
  firstIncompleteStep,
  neighbourStep,
  stepComplete,
  submitBlockers,
} from "@/lib/stepper";

const EMPTY: ApplicationFieldValues = {
  amountCents: null,
  termMonths: null,
  purpose: null,
  employmentStatus: null,
  employerName: null,
  monthsEmployed: null,
  annualIncomeCents: null,
  monthlyHousingCents: null,
  monthlyDebtCents: null,
  creditBand: null,
};
const FULL: ApplicationFieldValues = {
  amountCents: 1_500_000,
  termMonths: 36,
  purpose: "debt_consolidation",
  employmentStatus: "employed",
  employerName: "Northwind",
  monthsEmployed: 24,
  annualIncomeCents: 6_000_000,
  monthlyHousingCents: 120_000,
  monthlyDebtCents: 30_000,
  creditBand: "good",
};
const DOCS = [{ kind: "id" as const }, { kind: "pay_stub" as const }];

describe("buildPatch", () => {
  it("turns the loan step into integer cents", () => {
    expect(buildPatch("loan", { amountCents: "15,000.50", termMonths: "36", purpose: "vehicle" })).toEqual({
      ok: true,
      patch: { amountCents: 1_500_050, termMonths: 36, purpose: "vehicle" },
    });
  });
  it("allows an empty draft", () => {
    expect(buildPatch("loan", { amountCents: "", termMonths: "", purpose: "" })).toEqual({
      ok: true,
      patch: { amountCents: null, termMonths: null, purpose: null },
    });
  });
  it("rejects out-of-range and malformed values with a message per field", () => {
    const result = buildPatch("loan", { amountCents: "500", termMonths: "30", purpose: "yacht" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.amountCents).toContain("$1,000");
      expect(result.errors.amountCents).toContain("$50,000");
      expect(result.errors.termMonths).toBeTruthy();
      expect(result.errors.purpose).toBeTruthy();
    }
    expect(buildPatch("loan", { amountCents: "12.345", termMonths: "", purpose: "" }).ok).toBe(false);
  });
  it("keeps the employer only for people who work", () => {
    const base = { monthsEmployed: "12", annualIncomeCents: "60000" };
    expect(buildPatch("work", { ...base, employmentStatus: "employed", employerName: " Northwind " })).toEqual({
      ok: true,
      patch: { employmentStatus: "employed", employerName: "Northwind", monthsEmployed: 12, annualIncomeCents: 6_000_000 },
    });
    const retired = buildPatch("work", { ...base, employmentStatus: "retired", employerName: "Old Co" });
    expect(retired.ok && retired.patch.employerName).toBeNull();
  });
  it("checks months, income and employer length", () => {
    const result = buildPatch("work", {
      employmentStatus: "employed",
      employerName: "x".repeat(121),
      monthsEmployed: "601",
      annualIncomeCents: "30000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["annualIncomeCents", "employerName", "monthsEmployed"]);
    }
  });
  it("handles the payments step", () => {
    expect(buildPatch("payments", { monthlyHousingCents: "1,200", monthlyDebtCents: "0", creditBand: "fair" })).toEqual({
      ok: true,
      patch: { monthlyHousingCents: 120_000, monthlyDebtCents: 0, creditBand: "fair" },
    });
    expect(buildPatch("payments", { monthlyHousingCents: "-1", monthlyDebtCents: "", creditBand: "" }).ok).toBe(false);
  });
});

describe("step completeness", () => {
  it("agrees with the server's fieldsComplete", () => {
    const samples: ApplicationFieldValues[] = [
      EMPTY,
      FULL,
      { ...FULL, employerName: null },
      { ...FULL, employmentStatus: "retired", employerName: null },
      { ...FULL, creditBand: null },
      { ...FULL, monthsEmployed: null },
      { ...FULL, monthlyDebtCents: null },
      { ...FULL, termMonths: null },
    ];
    for (const sample of samples) {
      const stepsDone = (["loan", "work", "payments"] as const).every((s) => stepComplete(s, sample, DOCS));
      expect(stepsDone).toBe(fieldsComplete(sample));
    }
  });
  it("needs an id and an income document", () => {
    expect(documentGaps([])).toHaveLength(2);
    expect(documentGaps([{ kind: "id" }])).toEqual(["An income document (pay stub, bank statement or tax return)"]);
    expect(documentGaps([{ kind: "id" }, { kind: "tax_return" }])).toEqual([]);
    expect(documentGaps([{ kind: "other" }, { kind: "other" }])).toHaveLength(2);
  });
  it("opens on the first step that needs something", () => {
    expect(firstIncompleteStep(EMPTY, [])).toBe("loan");
    expect(firstIncompleteStep({ ...FULL, annualIncomeCents: null }, DOCS)).toBe("work");
    expect(firstIncompleteStep({ ...FULL, creditBand: null }, DOCS)).toBe("payments");
    expect(firstIncompleteStep(FULL, [])).toBe("documents");
    expect(firstIncompleteStep(FULL, DOCS)).toBe("review");
  });
  it("lists blockers and is empty when ready", () => {
    expect(submitBlockers(FULL, DOCS)).toEqual([]);
    expect(submitBlockers(EMPTY, [])).toContain("Loan amount");
    expect(submitBlockers(EMPTY, [])).toContain("An identification document");
  });
});

describe("neighbourStep", () => {
  it("moves within bounds", () => {
    expect(neighbourStep("loan", -1)).toBe("loan");
    expect(neighbourStep("loan", 1)).toBe("work");
    expect(neighbourStep("review", 1)).toBe("review");
    expect(STEP_IDS).toHaveLength(5);
  });
});
