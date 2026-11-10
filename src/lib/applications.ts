import "server-only";
import { and, count, desc, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { canReadApplication, contentWhere } from "@/lib/access";
import { appendAudit, recordApplicationView } from "@/lib/audit";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import {
  type ApplicationFieldValues,
  type ApplicationStatus,
  type QueueTab,
  INCOME_DOCUMENT_KINDS,
  OPEN_APPLICATION_CAP,
  applicationFields,
  applicationPatch,
  changedFieldNames,
  fieldsComplete,
  isEditableStatus,
  normalizeFields,
  parseUuid,
  planTransition,
  transitionBody,
} from "@/lib/loan";
import { advisoryLock, type Tx } from "@/lib/usage";

const app = schema.application;
const OPEN: ApplicationStatus[] = ["draft", "submitted", "in_review", "info_requested"];

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

function asFields(row: typeof app.$inferSelect): ApplicationFieldValues {
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

type ApplicationRow = typeof app.$inferSelect;
/** What an applicant sees of their own file: no reviewer identity and no underwriter's free-text decision note. */
export type ApplicantApplication = Omit<ApplicationRow, "assignedUnderwriterId" | "decisionNote"> & {
  assignedUnderwriterId?: undefined;
  decisionNote?: undefined;
};

function present(actor: Actor, row: ApplicationRow): ApplicationRow | ApplicantApplication {
  if (actor.role !== "user") return row;
  const { assignedUnderwriterId: _reviewer, decisionNote: _note, ...applicant } = row;
  void _reviewer;
  void _note;
  return applicant;
}

async function lockVisible(tx: Tx, actor: Actor, id: string, version?: number) {
  await advisoryLock(tx, `application:${id}`);
  const [row] = await tx.select().from(app).where(and(eq(app.id, id), contentWhere(actor)));
  if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
  if (version !== undefined && row.version !== version) {
    throw new ConflictError("This application was updated. Reload and try again.");
  }
  return row;
}

export async function listApplications(actor: Actor) {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  const rows = await db().select().from(app).where(eq(app.applicantId, actor.id)).orderBy(desc(app.updatedAt)).limit(50);
  return rows.filter((row) => canReadApplication(actor, row)).map((row) => present(actor, row));
}

export async function listQueue(actor: Actor, tab: QueueTab) {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "underwriter") throw new ForbiddenError();
  const where =
    tab === "new"
      ? and(
          inArray(app.status, ["submitted", "in_review"]),
          or(
            isNull(app.assignedUnderwriterId),
            notExists(
              db()
                .select({ one: sql`1` })
                .from(schema.user)
                .where(and(eq(schema.user.id, app.assignedUnderwriterId), eq(schema.user.role, "underwriter"))),
            ),
          ),
        )
      : tab === "mine"
        ? and(eq(app.assignedUnderwriterId, actor.id), inArray(app.status, ["in_review", "info_requested"]))
        : inArray(app.status, ["approved", "declined"]);
  const rows = await db().select().from(app).where(where).orderBy(desc(app.submittedAt)).limit(200);
  return rows.filter((row) => canReadApplication(actor, row));
}

export async function getApplication(actor: Actor, id: string) {
  const parsedId = parseUuid(id);
  return db().transaction(async (tx) => {
    const row = await lockVisible(tx, actor, parsedId);
    if (actor.role === "underwriter") {
      await recordApplicationView(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: "application.viewed",
        applicationId: row.id,
        detail: { status: row.status },
      });
    }
    return present(actor, row);
  });
}

export async function createApplication(actor: Actor, input: unknown = {}) {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  const fields = normalizeFields(applicationFields.parse(input ?? {}));
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `applicant-open:${actor.id}`);
    const [{ n }] = await tx
      .select({ n: count() })
      .from(app)
      .where(and(eq(app.applicantId, actor.id), inArray(app.status, OPEN)));
    if (n >= OPEN_APPLICATION_CAP) throw new ConflictError("You can have at most 3 open applications.");
    const [row] = await tx.insert(app).values({ applicantId: actor.id, ...fields }).returning();
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "application.created",
      applicationId: row.id,
      detail: {},
    });
    const names = changedFieldNames(EMPTY, fields);
    if (names.length > 0) {
      await appendAudit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: "application.updated",
        applicationId: row.id,
        detail: { fields: names },
      });
    }
    log.info("application.created", { applicationId: row.id });
    return present(actor, row);
  });
}

export async function updateApplication(actor: Actor, id: string, input: unknown) {
  const parsedId = parseUuid(id);
  const patch = applicationPatch.parse(input);
  const fields = normalizeFields(patch);
  return db().transaction(async (tx) => {
    const row = await lockVisible(tx, actor, parsedId, patch.version);
    if (actor.role !== "user" || row.applicantId !== actor.id) throw new ForbiddenError();
    if (!isEditableStatus(row.status)) throw new ConflictError("This application can't be edited now.");
    const names = changedFieldNames(asFields(row), fields);
    if (names.length === 0) return present(actor, row);
    const [next] = await tx
      .update(app)
      .set({ ...fields, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(app.id, row.id), eq(app.version, row.version)))
      .returning();
    if (!next) throw new ConflictError("This application was updated. Reload and try again.");
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "application.updated",
      applicationId: row.id,
      detail: { fields: names },
    });
    return present(actor, next);
  });
}

export async function deleteApplication(actor: Actor, id: string) {
  const parsedId = parseUuid(id);
  await db().transaction(async (tx) => {
    const row = await lockVisible(tx, actor, parsedId);
    if (actor.role !== "user" || row.applicantId !== actor.id) throw new ForbiddenError();
    if (row.status !== "draft") throw new ConflictError("Only a draft can be deleted.");
    const docs = await tx
      .select({ id: schema.document.id, kind: schema.document.kind })
      .from(schema.document)
      .where(eq(schema.document.applicationId, row.id));
    for (const doc of docs) {
      await appendAudit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: "document.deleted",
        applicationId: row.id,
        documentId: doc.id,
        detail: { kind: doc.kind },
      });
    }
    await tx.delete(app).where(eq(app.id, row.id));
  });
}

export async function transitionApplication(actor: Actor, id: string, input: unknown) {
  const parsedId = parseUuid(id);
  const body = transitionBody.parse(input);
  const message = body.message?.trim() ?? "";
  const note = body.note?.trim() ?? "";
  const codes = body.codes ?? [];
  return db().transaction(async (tx) => {
    const row = await lockVisible(tx, actor, parsedId, body.version);
    const docs = await tx
      .select({ kind: schema.document.kind })
      .from(schema.document)
      .where(and(eq(schema.document.applicationId, row.id), isNull(schema.document.deletedAt)));
    const effect = planTransition({
      from: row.status,
      to: body.to,
      role: actor.role,
      isOwner: row.applicantId === actor.id,
      isAssigned: row.assignedUnderwriterId === actor.id,
      isUnassigned: await isOrphaned(tx, row.assignedUnderwriterId),
      fieldsComplete: fieldsComplete(asFields(row)),
      hasIdDocument: docs.some((doc) => doc.kind === "id"),
      hasIncomeDocument: docs.some((doc) => (INCOME_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)),
      hasReplyOrDocument: message.length > 0 || (await hasApplicantReply(tx, row.id, row.applicantId)),
      message,
      codes,
      note,
    });

    const now = new Date();
    const base = { version: row.version + 1, updatedAt: now };
    let action = "application.submitted";
    let detail: Record<string, unknown> = { from: row.status, to: body.to };
    let values: Partial<typeof app.$inferInsert> = { ...base, status: body.to };

    if (effect.kind === "submit" || effect.kind === "resubmit") {
      values = { ...base, status: "submitted", submittedAt: now, assignedUnderwriterId: null };
      action = "application.submitted";
    } else if (effect.kind === "claim") {
      values = { ...base, status: "in_review", assignedUnderwriterId: actor.id };
      action = "application.claimed";
    } else if (effect.kind === "release") {
      values = { ...base, status: "submitted", assignedUnderwriterId: null };
      action = "application.released";
    } else if (effect.kind === "request_info") {
      values = { ...base, status: "info_requested" };
      action = "application.info_requested";
      await tx.insert(schema.applicationNote).values({
        applicationId: row.id,
        authorId: actor.id,
        visibility: "applicant",
        body: message,
      });
    } else if (effect.kind === "approve") {
      values = { ...base, status: "approved", decidedAt: now, decisionNote: note || null, decisionCodes: [] };
      action = "application.decided";
      detail = { from: row.status, to: "approved" };
    } else if (effect.kind === "decline") {
      values = { ...base, status: "declined", decidedAt: now, decisionNote: note || null, decisionCodes: effect.codes };
      action = "application.decided";
      detail = { from: row.status, to: "declined", codes: effect.codes };
    } else {
      values = { ...base, status: "withdrawn" };
      action = "application.withdrawn";
    }

    if (effect.kind === "resubmit" && message.length > 0) {
      await tx.insert(schema.applicationNote).values({
        applicationId: row.id,
        authorId: actor.id,
        visibility: "applicant",
        body: message,
      });
    }

    const [next] = await tx.update(app).set(values).where(and(eq(app.id, row.id), eq(app.version, row.version))).returning();
    if (!next) throw new ConflictError("This application was updated. Reload and try again.");
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action,
      applicationId: row.id,
      detail,
    });
    log.info("application.transition", { action, from: row.status, to: next.status, applicationId: row.id });
    return present(actor, next);
  });
}

/**
 * No one can act on the file: nobody is assigned, or the assignee is gone or no longer an underwriter
 * (belt and braces beside the release done when a role changes). Any underwriter may then release it.
 */
async function isOrphaned(tx: Tx, assigneeId: string | null): Promise<boolean> {
  if (assigneeId === null) return true;
  const [assignee] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, assigneeId));
  return !assignee || assignee.role !== "underwriter";
}

/** A document or an applicant note created after the latest information request. */
async function hasApplicantReply(tx: Tx, applicationId: string, applicantId: string): Promise<boolean> {
  const [info] = await tx.execute<{ at: Date | null }>(sql`
    select max(at) as at from audit_event
    where application_id = ${applicationId} and action = 'application.info_requested'
  `);
  if (!info?.at) return false;
  const since = new Date(info.at);
  const [doc] = await tx
    .select({ id: schema.document.id })
    .from(schema.document)
    .where(
      and(
        eq(schema.document.applicationId, applicationId),
        isNull(schema.document.deletedAt),
        gt(schema.document.uploadedAt, since),
      ),
    )
    .limit(1);
  if (doc) return true;
  const [note] = await tx
    .select({ id: schema.applicationNote.id })
    .from(schema.applicationNote)
    .where(
      and(
        eq(schema.applicationNote.applicationId, applicationId),
        eq(schema.applicationNote.authorId, applicantId),
        eq(schema.applicationNote.visibility, "applicant"),
        gt(schema.applicationNote.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(note);
}
