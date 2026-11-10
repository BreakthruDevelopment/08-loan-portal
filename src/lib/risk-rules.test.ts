import { describe, expect, it } from "vitest";
import {
  DEMO_APR_PCT,
  FLAG_CODES,
  type RiskInput,
  assessRisk,
  canonicalJson,
  monthlyPaymentCents,
} from "./risk-rules";

const base: RiskInput = {
  amountCents: 1_200_000,
  termMonths: 36,
  employmentStatus: "employed",
  monthsEmployed: 36,
  annualIncomeCents: 4_800_000,
  monthlyHousingCents: 80_000,
  monthlyDebtCents: 70_000,
  creditBand: "good",
  documentKinds: ["id", "pay_stub"],
};

const codes = (input: RiskInput) => assessRisk(input).flags.map((f) => f.code);

describe("hand-computed table of six applications", () => {
  // Each row was worked out independently of the code: payment = P*r / (1 - (1+r)^-n) with r = APR/12 at the band's
  // fixed APR, rounded to cents; monthly income = annual/12 rounded to cents; DTI = (housing + debt + payment) /
  // monthly income; LTI = amount / annual income; ratios rounded to one decimal.
  const table: {
    name: string;
    input: RiskInput;
    paymentCents: number;
    monthlyIncomeCents: number;
    dti: number | null;
    lti: number | null;
    flags: string[];
  }[] = [
    {
      name: "A: $12,000 / 36 mo / good, $48,000 income, $1,500 other debts (the 48% eval case)",
      input: base,
      paymentCents: 41_540,
      monthlyIncomeCents: 400_000,
      dti: 47.9,
      lti: 25,
      flags: ["DTI_HIGH", "INCOME_UNVERIFIED"],
    },
    {
      name: "B: $8,000 / 36 mo / excellent, $108,000 income, $1,700 other debts, 6 years employed",
      input: { ...base, amountCents: 800_000, creditBand: "excellent", annualIncomeCents: 10_800_000, monthlyHousingCents: 150_000, monthlyDebtCents: 20_000, monthsEmployed: 72 },
      paymentCents: 25_776,
      monthlyIncomeCents: 900_000,
      dti: 21.8,
      lti: 7.4,
      flags: ["INCOME_UNVERIFIED"],
    },
    {
      name: "C: $25,000 / 60 mo / poor, $60,000 income, 8 months employed",
      input: { ...base, amountCents: 2_500_000, termMonths: 60, creditBand: "poor", annualIncomeCents: 6_000_000, monthlyHousingCents: 140_000, monthlyDebtCents: 50_000, monthsEmployed: 8 },
      paymentCents: 80_730,
      monthlyIncomeCents: 500_000,
      dti: 54.1,
      lti: 41.7,
      flags: ["DTI_HIGH", "LTI_HIGH", "SHORT_EMPLOYMENT", "CREDIT_BAND_POOR", "INCOME_UNVERIFIED"],
    },
    {
      name: "D: $5,000 / 12 mo / fair, $30,000 income, $600 rent (elevated DTI, nothing else)",
      input: { ...base, amountCents: 500_000, termMonths: 12, creditBand: "fair", annualIncomeCents: 3_000_000, monthlyHousingCents: 60_000, monthlyDebtCents: 0 },
      paymentCents: 46_773,
      monthlyIncomeCents: 250_000,
      dti: 42.7,
      lti: 16.7,
      flags: ["DTI_ELEVATED", "INCOME_UNVERIFIED"],
    },
    {
      name: "E: $40,000 / 48 mo / unknown, $85,000 income, retired, no income document",
      input: { ...base, amountCents: 4_000_000, termMonths: 48, creditBand: "unknown", annualIncomeCents: 8_500_000, monthlyHousingCents: 180_000, monthlyDebtCents: 65_000, employmentStatus: "retired", documentKinds: ["id"] },
      paymentCents: 132_406,
      monthlyIncomeCents: 708_333,
      dti: 53.3,
      lti: 47.1,
      flags: ["DTI_HIGH", "LTI_HIGH", "NO_EMPLOYMENT_INCOME", "MISSING_INCOME_DOC", "INCOME_UNVERIFIED"],
    },
    {
      name: "F: zero stated income",
      input: { ...base, annualIncomeCents: 0, employmentStatus: "unemployed" },
      paymentCents: 41_540,
      monthlyIncomeCents: 0,
      dti: null,
      lti: null,
      flags: ["DTI_HIGH", "LTI_HIGH", "INCOME_UNVERIFIED"],
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const { metrics, flags } = assessRisk(row.input);
      expect(metrics.newPaymentCents).toBe(row.paymentCents);
      expect(metrics.monthlyIncomeCents).toBe(row.monthlyIncomeCents);
      expect(metrics.dtiPct).toBe(row.dti);
      expect(metrics.ltiPct).toBe(row.lti);
      expect(flags.map((f) => f.code)).toEqual(row.flags);
    });
  }
});

describe("rule edges", () => {
  it("uses the fixed APR per band", () => {
    expect(DEMO_APR_PCT).toEqual({ excellent: 9.9, good: 14.9, fair: 21.9, poor: 29.9, unknown: 24.9 });
    expect(monthlyPaymentCents(1_200_000, 36, 14.9)).toBe(41_540);
  });

  it("DTI thresholds: 43.0 is elevated, 43.1 is high, 36.0 is elevated, 35.9 is clean", () => {
    // Pick other debts so the total obligation hits the target exactly. Income $10,000/mo, payment fixed by the loan.
    const payment = monthlyPaymentCents(base.amountCents, base.termMonths, 14.9);
    const at = (dti: number) => ({ ...base, annualIncomeCents: 12_000_000, monthlyHousingCents: dti * 1000 - payment, monthlyDebtCents: 0 });
    expect(assessRisk(at(430)).metrics.dtiPct).toBe(43);
    expect(codes(at(430))).toContain("DTI_ELEVATED");
    expect(codes(at(431))).toContain("DTI_HIGH");
    expect(codes(at(431))).not.toContain("DTI_ELEVATED");
    expect(codes(at(360))).toContain("DTI_ELEVATED");
    expect(codes(at(359))).not.toContain("DTI_ELEVATED");
  });

  it("LTI is high only above 35%", () => {
    expect(codes({ ...base, amountCents: 1_680_000 })).not.toContain("LTI_HIGH"); // exactly 35.0%
    expect(codes({ ...base, amountCents: 1_690_000 })).toContain("LTI_HIGH"); // 35.2%
  });

  it("short employment applies to working applicants under 12 months only", () => {
    expect(codes({ ...base, monthsEmployed: 11 })).toContain("SHORT_EMPLOYMENT");
    expect(codes({ ...base, monthsEmployed: 12 })).not.toContain("SHORT_EMPLOYMENT");
    expect(codes({ ...base, monthsEmployed: 0, employmentStatus: "retired" })).not.toContain("SHORT_EMPLOYMENT");
  });

  it("NO_EMPLOYMENT_INCOME needs unemployed or retired plus claimed income", () => {
    expect(codes({ ...base, employmentStatus: "unemployed" })).toContain("NO_EMPLOYMENT_INCOME");
    expect(codes({ ...base, employmentStatus: "retired", annualIncomeCents: 0 })).not.toContain("NO_EMPLOYMENT_INCOME");
    expect(codes({ ...base, employmentStatus: "self_employed" })).not.toContain("NO_EMPLOYMENT_INCOME");
  });

  it("any one income document clears MISSING_INCOME_DOC; an ID or 'other' does not", () => {
    for (const kind of ["pay_stub", "bank_statement", "tax_return"] as const) {
      expect(codes({ ...base, documentKinds: ["id", kind] })).not.toContain("MISSING_INCOME_DOC");
    }
    expect(codes({ ...base, documentKinds: ["id", "other"] })).toContain("MISSING_INCOME_DOC");
  });

  it("INCOME_UNVERIFIED is always present, and every flag carries a reason, a rule and evidence", () => {
    const flags = assessRisk({ ...base, creditBand: "poor", monthsEmployed: 2, documentKinds: [] }).flags;
    expect(flags.map((f) => f.code)).toContain("INCOME_UNVERIFIED");
    for (const flag of flags) {
      expect(FLAG_CODES).toContain(flag.code);
      expect(flag.reason.length).toBeGreaterThan(10);
      expect(flag.rule.length).toBeGreaterThan(3);
      expect(flag.evidence.length).toBeGreaterThan(0);
    }
  });

  it("builds reasons from the numbers", () => {
    const dti = assessRisk(base).flags.find((f) => f.code === "DTI_HIGH")!;
    expect(dti.reason).toBe("Debt-to-income is 47.9% with the estimated new payment of $415.40, above the 43% limit.");
    expect(dti.rule).toBe("dti > 43");
  });

  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
