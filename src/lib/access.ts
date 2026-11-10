import "server-only";
import { type SQL, and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { application } from "@/lib/db/schema";

type AccessRow = { applicantId: string; status: string; submittedAt: Date | null };

/**
 * Who can see an application row. Admin never can (counts and the audit log only).
 * An applicant sees their own rows. An underwriter sees only submitted files.
 * Queries use `contentWhere` so the check is in SQL, not only after the row is loaded.
 */
// A withdrawn draft was never submitted (`submittedAt` is null), so underwriters still can't see it
// even though its status is no longer `draft`.
export function canReadApplication(actor: Actor, row: AccessRow): boolean {
  if (actor.role === "admin") return false;
  if (actor.role === "underwriter") return row.status !== "draft" && row.submittedAt !== null;
  return actor.role === "user" && row.applicantId === actor.id;
}

export function contentWhere(actor: Actor): SQL {
  if (actor.role === "admin") return sql`false`;
  if (actor.role === "underwriter") return and(ne(application.status, "draft"), isNotNull(application.submittedAt)) as SQL;
  return eq(application.applicantId, actor.id);
}

export function canReadNote(
  actor: Actor,
  row: AccessRow,
  visibility: "internal" | "applicant",
): boolean {
  if (!canReadApplication(actor, row)) return false;
  if (actor.role === "underwriter") return true;
  return visibility === "applicant";
}

/** Notes are closed once a file is final. */
const FINAL_NOTE_STATUSES = ["approved", "declined", "withdrawn"];

/**
 * Applicants write applicant-visible notes only while the underwriter is waiting on them (`info_requested`).
 * Underwriters write either kind on any file that isn't final.
 */
export function canWriteNote(actor: Actor, row: AccessRow, visibility: "internal" | "applicant"): boolean {
  if (!canReadApplication(actor, row)) return false;
  if (FINAL_NOTE_STATUSES.includes(row.status)) return false;
  if (actor.role === "underwriter") return true;
  return actor.role === "user" && visibility === "applicant" && row.status === "info_requested";
}
