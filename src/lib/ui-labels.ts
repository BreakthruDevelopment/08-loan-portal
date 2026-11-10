import type { Status } from "@/components/ui/StatusBadge";
import type { ApplicationStatus, DecisionCode, DocumentKind } from "@/lib/loan";

/** Plain-language labels for the enums. Client-safe: no database, no server-only imports. */

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  info_requested: "Information requested",
  approved: "Approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/** Which shared badge colour carries each status. Waiting is amber, approved is green, declined is red, the rest are neutral. */
export const STATUS_TONES: Record<ApplicationStatus, Status> = {
  draft: "not-started",
  submitted: "building",
  in_review: "building",
  info_requested: "degraded",
  approved: "live",
  declined: "blocked",
  withdrawn: "not-started",
};

export const PURPOSE_LABELS: Record<string, string> = {
  debt_consolidation: "Debt consolidation",
  home_improvement: "Home improvement",
  vehicle: "Vehicle",
  medical: "Medical",
  education: "Education",
  moving: "Moving",
  other: "Other",
};

export const EMPLOYMENT_LABELS: Record<string, string> = {
  employed: "Employed",
  self_employed: "Self-employed",
  unemployed: "Unemployed",
  retired: "Retired",
};

export const CREDIT_BAND_LABELS: Record<string, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  unknown: "I don't know",
};

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  id: "Identification",
  pay_stub: "Pay stub",
  bank_statement: "Bank statement",
  tax_return: "Tax return",
  other: "Other",
};

export const DECISION_CODE_LABELS: Record<DecisionCode, string> = {
  DTI_TOO_HIGH: "Debt-to-income ratio too high",
  INSUFFICIENT_INCOME: "Insufficient income",
  INCOMPLETE_DOCUMENTATION: "Incomplete documentation",
  SHORT_EMPLOYMENT: "Short employment history",
  UNVERIFIABLE_INFORMATION: "Information couldn't be verified",
  OTHER: "Other (see note)",
};

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  return map[value] ?? value.replaceAll("_", " ");
}

export type TimelineStep = { key: string; label: string; state: "done" | "current" | "todo" };

/**
 * The applicant's progress as a short list. A file that is waiting on the applicant shows "Information requested"
 * as the current step; a withdrawn one stops where it was. No reviewer is ever named.
 */
export function statusTimeline(status: ApplicationStatus): TimelineStep[] {
  if (status === "withdrawn") {
    return [
      { key: "draft", label: "Draft", state: "done" },
      { key: "withdrawn", label: "Withdrawn", state: "current" },
    ];
  }
  const order = ["draft", "submitted", "in_review", "decision"] as const;
  const position =
    status === "draft" ? 0 : status === "submitted" ? 1 : status === "in_review" || status === "info_requested" ? 2 : 3;
  const labels: Record<(typeof order)[number], string> = {
    draft: "Draft",
    submitted: "Submitted",
    in_review: status === "info_requested" ? "Information requested" : "In review",
    decision: status === "approved" ? "Approved" : status === "declined" ? "Declined" : "Decision",
  };
  return order.map((key, index) => ({
    key,
    label: labels[key],
    state: index < position ? "done" : index === position ? "current" : "todo",
  }));
}
