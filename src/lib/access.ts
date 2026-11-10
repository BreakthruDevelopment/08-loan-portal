import "server-only";
import { type SQL, eq, ne, sql } from "drizzle-orm";
import { type Actor } from "@/lib/auth/rbac";
import { application } from "@/lib/db/schema";

/**
 * Who can see an application row. Admin never can (counts and the audit log only).
 * An applicant sees their own rows. An underwriter sees everything except drafts.
 * Queries use `contentWhere` so the check is in SQL, not only after the row is loaded.
 */
export function canReadApplication(actor: Actor, row: { applicantId: string; status: string }): boolean {
  if (actor.role === "admin") return false;
  if (actor.role === "underwriter") return row.status !== "draft";
  return actor.role === "user" && row.applicantId === actor.id;
}

export function contentWhere(actor: Actor): SQL {
  if (actor.role === "admin") return sql`false`;
  if (actor.role === "underwriter") return ne(application.status, "draft");
  return eq(application.applicantId, actor.id);
}

export function canReadNote(
  actor: Actor,
  row: { applicantId: string; status: string },
  visibility: "internal" | "applicant",
): boolean {
  if (!canReadApplication(actor, row)) return false;
  if (actor.role === "underwriter") return true;
  return visibility === "applicant";
}

/** Applicants write applicant-visible notes on files they can read. Underwriters write either kind. */
export function canWriteNote(
  actor: Actor,
  row: { applicantId: string; status: string },
  visibility: "internal" | "applicant",
): boolean {
  if (!canReadApplication(actor, row)) return false;
  if (actor.role === "underwriter") return true;
  return actor.role === "user" && visibility === "applicant";
}
