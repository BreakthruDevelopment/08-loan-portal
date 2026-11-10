import { centsToInput, parseDollarsToCents, parseWholeNumber } from "@/lib/format";
import {
  AMOUNT_MAX_CENTS,
  AMOUNT_MIN_CENTS,
  CREDIT_BANDS,
  EMPLOYMENT_STATUSES,
  INCOME_DOCUMENT_KINDS,
  INCOME_MAX_CENTS,
  MONTHLY_MAX_CENTS,
  PURPOSES,
  TERMS,
  type ApplicationFieldValues,
  type DocumentKind,
} from "@/lib/loan";
import { formatCents } from "@/lib/format";

/** The applicant stepper's logic, kept apart from the components so it can be unit tested. */

export const STEP_IDS = ["loan", "work", "payments", "documents", "review"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  loan: "Loan",
  work: "Work and income",
  payments: "Monthly payments",
  documents: "Documents",
  review: "Review and submit",
};

export type FieldErrors = Partial<Record<keyof ApplicationFieldValues, string>>;
export type FieldStepId = "loan" | "work" | "payments";
export type PatchResult = { ok: true; patch: Partial<ApplicationFieldValues> } | { ok: false; errors: FieldErrors };

const WORKING = ["employed", "self_employed"];

function text(form: FormData | Record<string, string>, name: string): string {
  const value = form instanceof FormData ? form.get(name) : form[name];
  return typeof value === "string" ? value : "";
}

/**
 * Turn one step's form values into the PATCH body, or the per-field errors. Empty fields are allowed (it is a draft;
 * submit checks completeness). Money goes dollars -> integer cents by string arithmetic.
 */
export function buildPatch(step: FieldStepId, form: FormData | Record<string, string>): PatchResult {
  const errors: FieldErrors = {};
  const patch: Partial<ApplicationFieldValues> = {};

  const money = (name: keyof ApplicationFieldValues, min: number, max: number, what: string) => {
    const parsed = parseDollarsToCents(text(form, name));
    if (!parsed.ok) {
      errors[name] = `${what} must be a dollar amount like 1,500 or 1500.50.`;
      return;
    }
    if (parsed.cents !== null && (parsed.cents < min || parsed.cents > max)) {
      errors[name] =
        min > 0
          ? `${what} must be between ${formatCents(min).replace(".00", "")} and ${formatCents(max).replace(".00", "")}.`
          : `${what} can't be more than ${formatCents(max).replace(".00", "")}.`;
      return;
    }
    (patch as Record<string, unknown>)[name] = parsed.cents;
  };

  if (step === "loan") {
    money("amountCents", AMOUNT_MIN_CENTS, AMOUNT_MAX_CENTS, "Loan amount");
    const term = text(form, "termMonths");
    if (term === "") patch.termMonths = null;
    else if ((TERMS as readonly number[]).includes(Number(term))) patch.termMonths = Number(term);
    else errors.termMonths = "Choose one of the listed terms.";
    const purpose = text(form, "purpose");
    if (purpose === "") patch.purpose = null;
    else if ((PURPOSES as readonly string[]).includes(purpose)) patch.purpose = purpose as ApplicationFieldValues["purpose"];
    else errors.purpose = "Choose one of the listed purposes.";
  }

  if (step === "work") {
    const status = text(form, "employmentStatus");
    if (status === "") patch.employmentStatus = null;
    else if ((EMPLOYMENT_STATUSES as readonly string[]).includes(status)) {
      patch.employmentStatus = status as ApplicationFieldValues["employmentStatus"];
    } else errors.employmentStatus = "Choose one of the listed options.";
    const employer = text(form, "employerName").trim();
    if (employer.length > 120) errors.employerName = "Employer name can be up to 120 characters.";
    else patch.employerName = status !== "" && !WORKING.includes(status) ? null : employer === "" ? null : employer;
    const months = parseWholeNumber(text(form, "monthsEmployed"));
    if (!months.ok || (months.value !== null && months.value > 600)) {
      errors.monthsEmployed = "Months employed must be a whole number from 0 to 600.";
    } else patch.monthsEmployed = months.value;
    money("annualIncomeCents", 0, INCOME_MAX_CENTS, "Annual income");
  }

  if (step === "payments") {
    money("monthlyHousingCents", 0, MONTHLY_MAX_CENTS, "Monthly housing payment");
    money("monthlyDebtCents", 0, MONTHLY_MAX_CENTS, "Monthly debt payments");
    const band = text(form, "creditBand");
    if (band === "") patch.creditBand = null;
    else if ((CREDIT_BANDS as readonly string[]).includes(band)) patch.creditBand = band as ApplicationFieldValues["creditBand"];
    else errors.creditBand = "Choose one of the listed options.";
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, patch };
}

export function fieldDefaults(fields: ApplicationFieldValues) {
  return {
    amountCents: centsToInput(fields.amountCents),
    annualIncomeCents: centsToInput(fields.annualIncomeCents),
    monthlyHousingCents: centsToInput(fields.monthlyHousingCents),
    monthlyDebtCents: centsToInput(fields.monthlyDebtCents),
  };
}

/** Which required fields are still empty, as the labels an applicant would recognise. */
export function missingFieldsForStep(step: FieldStepId, f: ApplicationFieldValues): string[] {
  const missing: string[] = [];
  if (step === "loan") {
    if (f.amountCents === null) missing.push("Loan amount");
    if (f.termMonths === null) missing.push("Term");
    if (!f.purpose) missing.push("Purpose");
  } else if (step === "work") {
    if (!f.employmentStatus) missing.push("Employment status");
    if ((f.employmentStatus === "employed" || f.employmentStatus === "self_employed") && !f.employerName) {
      missing.push("Employer name");
    }
    if (f.monthsEmployed === null) missing.push("Months employed");
    if (f.annualIncomeCents === null) missing.push("Annual income");
  } else {
    if (f.monthlyHousingCents === null) missing.push("Monthly housing payment");
    if (f.monthlyDebtCents === null) missing.push("Monthly debt payments");
    if (!f.creditBand) missing.push("Credit band");
  }
  return missing;
}

export function documentGaps(docs: { kind: DocumentKind }[]): string[] {
  const gaps: string[] = [];
  if (!docs.some((d) => d.kind === "id")) gaps.push("An identification document");
  if (!docs.some((d) => (INCOME_DOCUMENT_KINDS as readonly string[]).includes(d.kind))) {
    gaps.push("An income document (pay stub, bank statement or tax return)");
  }
  return gaps;
}

export function stepComplete(step: StepId, fields: ApplicationFieldValues, docs: { kind: DocumentKind }[]): boolean {
  if (step === "documents") return documentGaps(docs).length === 0;
  if (step === "review") return STEP_IDS.slice(0, 4).every((s) => stepComplete(s, fields, docs));
  return missingFieldsForStep(step, fields).length === 0;
}

/** Where to open the stepper: the first step that still needs something, else the review step. */
export function firstIncompleteStep(fields: ApplicationFieldValues, docs: { kind: DocumentKind }[]): StepId {
  return STEP_IDS.slice(0, 4).find((s) => !stepComplete(s, fields, docs)) ?? "review";
}

/** Everything the server's submit rule would refuse, in words. Empty means ready to submit. */
export function submitBlockers(fields: ApplicationFieldValues, docs: { kind: DocumentKind }[]): string[] {
  return [
    ...missingFieldsForStep("loan", fields),
    ...missingFieldsForStep("work", fields),
    ...missingFieldsForStep("payments", fields),
    ...documentGaps(docs),
  ];
}

export function neighbourStep(step: StepId, direction: 1 | -1): StepId {
  const index = STEP_IDS.indexOf(step) + direction;
  return STEP_IDS[Math.min(Math.max(index, 0), STEP_IDS.length - 1)];
}
