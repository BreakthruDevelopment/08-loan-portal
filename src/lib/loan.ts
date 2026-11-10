import { z } from "zod";
import { type Role } from "@/lib/auth/rbac";
import { ForbiddenError } from "@/lib/auth/rbac";
import { ConflictError, NotFoundError } from "@/lib/errors";

/** Personal-loan statuses. Final states are approved, declined, and withdrawn. */
export const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "in_review",
  "info_requested",
  "approved",
  "declined",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const FINAL_STATUSES = ["approved", "declined", "withdrawn"] as const;
export const PURPOSES = [
  "debt_consolidation",
  "home_improvement",
  "vehicle",
  "medical",
  "education",
  "moving",
  "other",
] as const;
export const EMPLOYMENT_STATUSES = ["employed", "self_employed", "unemployed", "retired"] as const;
export const CREDIT_BANDS = ["excellent", "good", "fair", "poor", "unknown"] as const;
export const TERMS = [12, 24, 36, 48, 60] as const;
export const DOCUMENT_KINDS = ["id", "pay_stub", "bank_statement", "tax_return", "other"] as const;
export const INCOME_DOCUMENT_KINDS = ["pay_stub", "bank_statement", "tax_return"] as const;
export const CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const DECISION_CODES = [
  "DTI_TOO_HIGH",
  "INSUFFICIENT_INCOME",
  "INCOMPLETE_DOCUMENTATION",
  "SHORT_EMPLOYMENT",
  "UNVERIFIABLE_INFORMATION",
  "OTHER",
] as const;
export const NOTE_VISIBILITIES = ["internal", "applicant"] as const;
export const QUEUE_TABS = ["new", "mine", "decided"] as const;

export type Purpose = (typeof PURPOSES)[number];
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export type CreditBand = (typeof CREDIT_BANDS)[number];
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type DecisionCode = (typeof DECISION_CODES)[number];
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];
export type QueueTab = (typeof QUEUE_TABS)[number];

/** $1,000 to $50,000, stored in cents. */
export const AMOUNT_MIN_CENTS = 100_000;
export const AMOUNT_MAX_CENTS = 5_000_000;
/** Sanity ceilings so a draft can't store an unbounded number. */
/** Stored in a 32-bit integer column (max 2,147,483,647), so the cap stays below that. */
export const INCOME_MAX_CENTS = 2_000_000_000;
export const MONTHLY_MAX_CENTS = 10_000_000_00;
export const OPEN_APPLICATION_CAP = 3;
export const NOTES_PER_APPLICATION_CAP = 50;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_APPLICATION = 8;
export const MAX_BYTES_PER_APPLICATION = 20 * 1024 * 1024;

export function isFinalStatus(status: ApplicationStatus): boolean {
  return (FINAL_STATUSES as readonly string[]).includes(status);
}

export function isEditableStatus(status: ApplicationStatus): boolean {
  return status === "draft" || status === "info_requested";
}

export function parseUuid(id: string): string {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

const money = (max: number) => z.number().int().min(0).max(max);
const optionalMoney = (max: number) => money(max).nullable().optional();

export const applicationFields = z
  .object({
    amountCents: z.number().int().min(AMOUNT_MIN_CENTS).max(AMOUNT_MAX_CENTS).nullable().optional(),
    termMonths: z.union([z.literal(12), z.literal(24), z.literal(36), z.literal(48), z.literal(60)]).nullable().optional(),
    purpose: z.enum(PURPOSES).nullable().optional(),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).nullable().optional(),
    employerName: z.string().max(120).nullable().optional(),
    monthsEmployed: z.number().int().min(0).max(600).nullable().optional(),
    annualIncomeCents: optionalMoney(INCOME_MAX_CENTS),
    monthlyHousingCents: optionalMoney(MONTHLY_MAX_CENTS),
    monthlyDebtCents: optionalMoney(MONTHLY_MAX_CENTS),
    creditBand: z.enum(CREDIT_BANDS).nullable().optional(),
  })
  .strict();

export const applicationPatch = applicationFields.extend({ version: z.number().int().positive() });

export const transitionBody = z
  .object({
    to: z.enum(["submitted", "in_review", "info_requested", "approved", "declined", "withdrawn"]),
    version: z.number().int().positive(),
    message: z.string().max(1000).optional(),
    codes: z.array(z.enum(DECISION_CODES)).max(4).optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const noteBody = z
  .object({
    body: z.string().trim().min(1).max(2000),
    visibility: z.enum(NOTE_VISIBILITIES).optional(),
  })
  .strict();

export type ApplicationFieldInput = z.infer<typeof applicationFields>;

export type ApplicationFieldValues = {
  amountCents: number | null;
  termMonths: number | null;
  purpose: Purpose | null;
  employmentStatus: EmploymentStatus | null;
  employerName: string | null;
  monthsEmployed: number | null;
  annualIncomeCents: number | null;
  monthlyHousingCents: number | null;
  monthlyDebtCents: number | null;
  creditBand: CreditBand | null;
};

const FIELD_NAMES = [
  "amountCents",
  "termMonths",
  "purpose",
  "employmentStatus",
  "employerName",
  "monthsEmployed",
  "annualIncomeCents",
  "monthlyHousingCents",
  "monthlyDebtCents",
  "creditBand",
] as const satisfies readonly (keyof ApplicationFieldValues)[];

/** Empty employer names become null. Returns only the keys the caller sent. */
export function normalizeFields(input: ApplicationFieldInput): Partial<ApplicationFieldValues> {
  const out: Partial<ApplicationFieldValues> = {};
  for (const key of FIELD_NAMES) {
    if (input[key] === undefined) continue;
    if (key === "employerName") {
      const raw = input.employerName;
      if (raw === undefined) continue;
      out.employerName = raw === null ? null : raw.trim() || null;
      continue;
    }
    out[key] = input[key] as never;
  }
  return out;
}

export function changedFieldNames(current: ApplicationFieldValues, next: Partial<ApplicationFieldValues>): string[] {
  return FIELD_NAMES.filter((key) => next[key] !== undefined && next[key] !== current[key]);
}

/** Every field the submit transition requires. Employer is required only when the applicant is working. */
export function fieldsComplete(row: ApplicationFieldValues): boolean {
  if (row.amountCents === null || row.termMonths === null || !(TERMS as readonly number[]).includes(row.termMonths)) return false;
  if (!row.purpose || !row.employmentStatus || row.monthsEmployed === null || !row.creditBand) return false;
  if (row.annualIncomeCents === null || row.monthlyHousingCents === null || row.monthlyDebtCents === null) return false;
  const working = row.employmentStatus === "employed" || row.employmentStatus === "self_employed";
  if (working && !row.employerName) return false;
  return true;
}

export type TransitionPlanInput = {
  from: ApplicationStatus;
  to: z.infer<typeof transitionBody>["to"];
  role: Role;
  isOwner: boolean;
  isAssigned: boolean;
  /** No underwriter holds the file (the assignee was deleted or demoted). Any underwriter may release it. */
  isUnassigned?: boolean;
  fieldsComplete: boolean;
  hasIdDocument: boolean;
  hasIncomeDocument: boolean;
  hasReplyOrDocument: boolean;
  message: string;
  codes: DecisionCode[];
  note: string;
};

export type TransitionEffect =
  | { kind: "submit" }
  | { kind: "claim" }
  | { kind: "release" }
  | { kind: "request_info" }
  | { kind: "resubmit" }
  | { kind: "approve" }
  | { kind: "decline"; codes: DecisionCode[] }
  | { kind: "withdraw" };

/**
 * One row of the state table. Throws 403 when this actor may not take the step,
 * and 409 when the step isn't legal from this state or its requirements are missing.
 * The caller has already hidden rows the actor cannot see.
 */
export function planTransition(input: TransitionPlanInput): TransitionEffect {
  const { from, to, role, isOwner, isAssigned } = input;
  if (isFinalStatus(from)) throw new ConflictError("A final application can't be changed.");

  if (to === "withdrawn") {
    if (role !== "user" || !isOwner) throw new ForbiddenError();
    return { kind: "withdraw" };
  }

  if (from === "draft" && to === "submitted") {
    if (role !== "user" || !isOwner) throw new ForbiddenError();
    if (!input.fieldsComplete) throw new ConflictError("Fill in every required field before submitting.");
    if (!input.hasIdDocument || !input.hasIncomeDocument) {
      throw new ConflictError("Submit needs an identification document and an income document.");
    }
    return { kind: "submit" };
  }

  if (from === "submitted" && to === "in_review") {
    if (role !== "underwriter") throw new ForbiddenError();
    return { kind: "claim" };
  }

  if (from === "in_review" && to === "submitted") {
    // An in_review file with no assignee (the underwriter's account was deleted) would be stuck, so any underwriter may release it.
    if (role !== "underwriter" || !(isAssigned || input.isUnassigned)) throw new ForbiddenError();
    return { kind: "release" };
  }

  if (from === "in_review" && to === "info_requested") {
    if (role !== "underwriter" || !isAssigned) throw new ForbiddenError();
    if (input.message.trim().length < 1) throw new ConflictError("Tell the applicant what you need.");
    return { kind: "request_info" };
  }

  if (from === "info_requested" && to === "submitted") {
    if (role !== "user" || !isOwner) throw new ForbiddenError();
    // The applicant can edit fields and delete documents while information is requested, so re-check what submit checks.
    if (!input.fieldsComplete) throw new ConflictError("Fill in every required field before submitting.");
    if (!input.hasIdDocument || !input.hasIncomeDocument) {
      throw new ConflictError("Submit needs an identification document and an income document.");
    }
    if (!input.hasReplyOrDocument && input.message.trim().length < 1) {
      throw new ConflictError("Reply to the request or add a document before sending the application back.");
    }
    return { kind: "resubmit" };
  }

  if (from === "in_review" && (to === "approved" || to === "declined")) {
    if (role !== "underwriter" || !isAssigned) throw new ForbiddenError();
    if (to === "approved") {
      if (input.codes.length > 0) throw new ConflictError("An approval doesn't take reason codes.");
      return { kind: "approve" };
    }
    const unique = new Set(input.codes);
    if (input.codes.length < 1 || input.codes.length > 4 || unique.size !== input.codes.length) {
      throw new ConflictError("Choose 1 to 4 reason codes.");
    }
    if (input.codes.includes("OTHER") && input.note.trim().length < 1) throw new ConflictError("OTHER needs a note.");
    return { kind: "decline", codes: input.codes };
  }

  throw new ConflictError("That change isn't allowed from the current state.");
}
