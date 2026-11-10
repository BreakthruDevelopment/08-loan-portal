/**
 * Deterministic risk rules. Pure functions: no database, no model, no clock. The reasons an
 * underwriter reads always come from here, so they are correct in demo mode and when the model
 * is down. The AI summary only explains what these rules computed (see risk-ai.ts).
 *
 * Conventions, so the numbers are reproducible by hand:
 * - Money is integer cents. Monthly income = round(annual / 12).
 * - The estimated new payment is a standard amortization at a fixed demo APR per credit band
 *   (not a pricing offer), rounded to whole cents.
 * - DTI % = (housing + other debt + new payment) / monthly income * 100, and LTI % = amount /
 *   annual income * 100. Both are rounded to one decimal, and the thresholds apply to the rounded
 *   value, so the number shown in a reason is the number the rule used.
 */
import { type CreditBand, type DocumentKind, type EmploymentStatus, INCOME_DOCUMENT_KINDS } from "@/lib/loan";

/** Demo APR by credit band, in percent. Fixed so the metric is explainable, not a quote. */
export const DEMO_APR_PCT: Record<CreditBand, number> = {
  excellent: 9.9,
  good: 14.9,
  fair: 21.9,
  poor: 29.9,
  unknown: 24.9,
};

export const THRESHOLDS = {
  dtiHighAbove: 43,
  dtiElevatedFrom: 36,
  ltiHighAbove: 35,
  shortEmploymentMonths: 12,
} as const;

export const FLAG_CODES = [
  "DTI_HIGH",
  "DTI_ELEVATED",
  "LTI_HIGH",
  "SHORT_EMPLOYMENT",
  "NO_EMPLOYMENT_INCOME",
  "MISSING_INCOME_DOC",
  "CREDIT_BAND_POOR",
  "INCOME_UNVERIFIED",
] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

/** The metric names a summary may cite as evidence. */
export const METRIC_NAMES = ["monthly_income", "new_payment", "dti", "lti", "months_employed", "credit_band", "documents"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type Severity = "high" | "medium" | "info";

/** Which metrics each rule is about. The first entry is the primary evidence. */
export const FLAG_METRICS: Record<FlagCode, readonly MetricName[]> = {
  DTI_HIGH: ["dti", "monthly_income", "new_payment"],
  DTI_ELEVATED: ["dti", "monthly_income", "new_payment"],
  LTI_HIGH: ["lti", "monthly_income"],
  SHORT_EMPLOYMENT: ["months_employed"],
  NO_EMPLOYMENT_INCOME: ["monthly_income"],
  MISSING_INCOME_DOC: ["documents"],
  CREDIT_BAND_POOR: ["credit_band"],
  INCOME_UNVERIFIED: ["monthly_income", "documents"],
};

export type RiskInput = {
  amountCents: number;
  termMonths: number;
  employmentStatus: EmploymentStatus;
  monthsEmployed: number;
  annualIncomeCents: number;
  monthlyHousingCents: number;
  monthlyDebtCents: number;
  creditBand: CreditBand;
  /** Kinds of the application's current (not deleted) documents, one entry per document. */
  documentKinds: readonly DocumentKind[];
};

export type RiskMetrics = {
  monthlyIncomeCents: number;
  newPaymentCents: number;
  assumedAprPct: number;
  /** Null when stated income is zero (the ratio is undefined). */
  dtiPct: number | null;
  ltiPct: number | null;
  monthsEmployed: number;
  creditBand: CreditBand;
  documents: Record<DocumentKind, number>;
};

export type RuleFlag = {
  code: FlagCode;
  severity: Severity;
  /** Plain-language reason built from the numbers. Safe to show to underwriters verbatim. */
  reason: string;
  /** The rule as written, so each reason is traceable (an examiner can find it). */
  rule: string;
  /** The metrics the rule reads. */
  evidence: MetricName[];
};

export type RiskAssessment = { metrics: RiskMetrics; flags: RuleFlag[] };

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Level-payment amortization in whole cents. */
export function monthlyPaymentCents(amountCents: number, termMonths: number, aprPct: number): number {
  const r = aprPct / 100 / 12;
  if (r === 0) return Math.round(amountCents / termMonths);
  return Math.round((amountCents * r) / (1 - Math.pow(1 + r, -termMonths)));
}

export function computeMetrics(input: RiskInput): RiskMetrics {
  const monthlyIncomeCents = Math.round(input.annualIncomeCents / 12);
  const assumedAprPct = DEMO_APR_PCT[input.creditBand];
  const newPaymentCents = monthlyPaymentCents(input.amountCents, input.termMonths, assumedAprPct);
  const obligations = input.monthlyHousingCents + input.monthlyDebtCents + newPaymentCents;
  const documents: Record<DocumentKind, number> = { id: 0, pay_stub: 0, bank_statement: 0, tax_return: 0, other: 0 };
  for (const kind of input.documentKinds) documents[kind] += 1;
  return {
    monthlyIncomeCents,
    newPaymentCents,
    assumedAprPct,
    dtiPct: monthlyIncomeCents > 0 ? round1((obligations / monthlyIncomeCents) * 100) : null,
    ltiPct: input.annualIncomeCents > 0 ? round1((input.amountCents / input.annualIncomeCents) * 100) : null,
    monthsEmployed: input.monthsEmployed,
    creditBand: input.creditBand,
    documents,
  };
}

export const formatPct = (value: number) => `${value.toFixed(1)}%`;
export const formatUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function computeFlags(input: RiskInput, metrics: RiskMetrics): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const add = (code: FlagCode, severity: Severity, rule: string, reason: string) =>
    flags.push({ code, severity, rule, reason, evidence: [...FLAG_METRICS[code]] });
  const { dtiPct, ltiPct } = metrics;

  if (dtiPct === null) {
    add(
      "DTI_HIGH",
      "high",
      "stated monthly income is zero, so DTI can't be at or below the limit",
      "Stated income is zero, so debt-to-income can't be measured and is treated as too high.",
    );
  } else if (dtiPct > THRESHOLDS.dtiHighAbove) {
    add(
      "DTI_HIGH",
      "high",
      `dti > ${THRESHOLDS.dtiHighAbove}`,
      `Debt-to-income is ${formatPct(dtiPct)} with the estimated new payment of ${formatUsd(metrics.newPaymentCents)}, above the ${THRESHOLDS.dtiHighAbove}% limit.`,
    );
  } else if (dtiPct >= THRESHOLDS.dtiElevatedFrom) {
    add(
      "DTI_ELEVATED",
      "medium",
      `${THRESHOLDS.dtiElevatedFrom} <= dti <= ${THRESHOLDS.dtiHighAbove}`,
      `Debt-to-income is ${formatPct(dtiPct)} with the estimated new payment of ${formatUsd(metrics.newPaymentCents)}, between ${THRESHOLDS.dtiElevatedFrom}% and ${THRESHOLDS.dtiHighAbove}%.`,
    );
  }

  if (input.annualIncomeCents === 0) {
    add(
      "LTI_HIGH",
      "medium",
      "stated annual income is zero, so loan-to-income can't be measured",
      "Stated income is zero, so loan-to-income can't be measured and is treated as too high.",
    );
  } else if (ltiPct !== null && ltiPct > THRESHOLDS.ltiHighAbove) {
    add("LTI_HIGH", "medium", `lti > ${THRESHOLDS.ltiHighAbove}`, `The loan is ${formatPct(ltiPct)} of annual income, above the ${THRESHOLDS.ltiHighAbove}% limit.`);
  }

  const working = input.employmentStatus === "employed" || input.employmentStatus === "self_employed";
  if (working && metrics.monthsEmployed < THRESHOLDS.shortEmploymentMonths) {
    add(
      "SHORT_EMPLOYMENT",
      "medium",
      `employed or self_employed and months_employed < ${THRESHOLDS.shortEmploymentMonths}`,
      `Time in current employment is ${metrics.monthsEmployed} ${metrics.monthsEmployed === 1 ? "month" : "months"}, under ${THRESHOLDS.shortEmploymentMonths} months.`,
    );
  }

  if ((input.employmentStatus === "unemployed" || input.employmentStatus === "retired") && metrics.monthlyIncomeCents > 0) {
    add(
      "NO_EMPLOYMENT_INCOME",
      "high",
      "employment status is unemployed or retired and income is claimed",
      `Employment status is ${input.employmentStatus} but income of ${formatUsd(metrics.monthlyIncomeCents)} a month is stated.`,
    );
  }

  const hasIncomeDoc = INCOME_DOCUMENT_KINDS.some((kind) => metrics.documents[kind] > 0);
  if (!hasIncomeDoc) {
    add("MISSING_INCOME_DOC", "high", "no pay stub, bank statement or tax return on file", "No pay stub, bank statement or tax return is on file to support the stated income.");
  }

  if (metrics.creditBand === "poor") {
    add("CREDIT_BAND_POOR", "medium", "credit_band = poor", "The applicant reports a poor credit band (self-reported, not checked with a bureau).");
  }

  add(
    "INCOME_UNVERIFIED",
    "info",
    "always: documents are not read in this version",
    "Stated income hasn't been checked against the documents; the system doesn't read document contents.",
  );
  return flags;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const metrics = computeMetrics(input);
  return { metrics, flags: computeFlags(input, metrics) };
}

/** JSON with sorted keys, so the same assessment always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    const record = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sort(record[k])]));
  };
  return JSON.stringify(sort(value));
}
