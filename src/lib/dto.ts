import type { ApplicationFieldValues, ApplicationStatus, DocumentKind } from "@/lib/loan";

/**
 * The plain objects server pages hand to client components. Dates are ISO strings. Applicant-facing shapes carry no
 * reviewer, no decision note and no internal notes: those fields don't exist here, so they can't be rendered by mistake.
 */

export type ApplicationDto = {
  id: string;
  status: ApplicationStatus;
  version: number;
  fields: ApplicationFieldValues;
  decisionCodes: string[];
  submittedAt: string | null;
  decidedAt: string | null;
};

export type DocumentDto = {
  id: string;
  kind: DocumentKind;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  deletable: boolean;
};

export type MessageDto = { id: string; body: string; createdAt: string; author: "you" | "underwriter" };

export function toFields(row: ApplicationFieldValues): ApplicationFieldValues {
  return {
    amountCents: row.amountCents,
    termMonths: row.termMonths,
    purpose: row.purpose,
    employmentStatus: row.employmentStatus,
    employerName: row.employerName,
    monthsEmployed: row.monthsEmployed,
    annualIncomeCents: row.annualIncomeCents,
    monthlyHousingCents: row.monthlyHousingCents,
    monthlyDebtCents: row.monthlyDebtCents,
    creditBand: row.creditBand,
  };
}
