import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { auditEvent } from "@/lib/db/schema";
import { BadRequestError } from "@/lib/errors";
import { log } from "@/lib/log";
import { advisoryLock, type Tx } from "@/lib/usage";

/**
 * Genesis row inserted by the migration. `verifyAuditChain` recomputes this hash,
 * so the SQL literal and `canonicalAuditPayload` have to stay the same.
 */
export const AUDIT_GENESIS = {
  id: 1,
  at: new Date("2026-01-01T00:00:00.000Z"),
  actorId: "system",
  actorRole: "system",
  action: "audit.genesis",
  applicationId: null as string | null,
  documentId: null as string | null,
  detail: {} as Record<string, unknown>,
};

const DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,40}$/;
const FORBIDDEN_DETAIL_KEYS = new Set([
  "amount",
  "amountCents",
  "annualIncomeCents",
  "monthlyHousingCents",
  "monthlyDebtCents",
  "body",
  "note",
  "message",
  "name",
  "email",
  "filename",
  "displayName",
  "employer",
  "employerName",
  "password",
]);

/** Detail is field names, statuses, reason codes, and ids. Never amounts, names, filenames, or note text. */
export function assertSafeDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) throw new BadRequestError("Audit detail must be an object.");
  const record = detail as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!DETAIL_KEY.test(key) || FORBIDDEN_DETAIL_KEYS.has(key)) throw new BadRequestError("Audit detail can't include values.");
    if (typeof value === "string") {
      if (value.length > 128) throw new BadRequestError("Audit detail can't include values.");
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 8 || value.some((item) => typeof item !== "string" || item.length > 80)) {
        throw new BadRequestError("Audit detail can't include values.");
      }
      continue;
    }
    throw new BadRequestError("Audit detail can't include values.");
  }
  if (JSON.stringify(record).length > 2048) throw new BadRequestError("Audit detail is too large.");
  return record;
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
  return sorted;
}

export type AuditPayload = {
  id: number;
  at: Date;
  actorId: string;
  actorRole: string;
  action: string;
  applicationId: string | null;
  documentId: string | null;
  detail: unknown;
};

/** Fixed key order. `at` is millisecond UTC so it round-trips through timestamp(3). */
export function canonicalAuditPayload(row: AuditPayload): string {
  return JSON.stringify({
    id: Number(row.id),
    at: row.at.toISOString(),
    actor_id: row.actorId,
    actor_role: row.actorRole,
    action: row.action,
    application_id: row.applicationId,
    document_id: row.documentId,
    detail: canonicalize(row.detail ?? {}),
  });
}

/** sha256(prev_hash ‖ canonical JSON). A missing previous hash is the empty string. */
export function auditHash(prevHash: string | null, payload: string): string {
  return createHash("sha256")
    .update(prevHash ?? "", "utf8")
    .update(payload, "utf8")
    .digest("hex");
}

export type AuditWrite = {
  actorId: string;
  actorRole: string;
  action: string;
  applicationId?: string | null;
  documentId?: string | null;
  detail?: Record<string, unknown>;
};

/**
 * Append one audit row in the caller's transaction. The advisory lock serializes the
 * chain. The hash is stored on insert: a trigger rejects updates, so it cannot be filled in later.
 */
export async function appendAudit(tx: Tx, event: AuditWrite): Promise<number> {
  await advisoryLock(tx, "audit-chain");
  const detail = assertSafeDetail(event.detail ?? {});
  const [prev] = await tx.select({ hash: auditEvent.hash }).from(auditEvent).orderBy(desc(auditEvent.id)).limit(1);
  const prevHash = prev ? prev.hash.trim() : null;
  const [clock] = await tx.execute<{ now: Date }>(sql`select date_trunc('milliseconds', clock_timestamp()) as now`);
  const at = new Date(clock.now);
  const [seq] = await tx.execute<{ id: number }>(sql`select nextval('audit_event_id_seq')::int as id`);
  const id = Number(seq.id);
  const payload = canonicalAuditPayload({
    id,
    at,
    actorId: event.actorId,
    actorRole: event.actorRole,
    action: event.action,
    applicationId: event.applicationId ?? null,
    documentId: event.documentId ?? null,
    detail,
  });
  const hash = auditHash(prevHash, payload);
  await tx.insert(auditEvent).values({
    id,
    at,
    actorId: event.actorId,
    actorRole: event.actorRole,
    action: event.action,
    applicationId: event.applicationId ?? null,
    documentId: event.documentId ?? null,
    detail,
    prevHash,
    hash,
  });
  log.info("audit.append", {
    action: event.action,
    applicationId: event.applicationId ?? null,
    documentId: event.documentId ?? null,
  });
  return id;
}

/** At most one `application.viewed` per underwriter per application per hour. */
export async function recordApplicationView(tx: Tx, event: AuditWrite): Promise<void> {
  await advisoryLock(tx, "audit-chain");
  const recent = await tx.execute<{ n: number }>(sql`
    select 1 as n from audit_event
    where action = 'application.viewed'
      and actor_id = ${event.actorId}
      and application_id = ${event.applicationId ?? null}
      and at > now() - interval '1 hour'
    limit 1
  `);
  if (recent.length > 0) return;
  await appendAudit(tx, event);
}

export type ChainResult = { ok: true; checked: number } | { ok: false; id: number; reason: string };

/** Walk the chain in id order and report the first broken link. Admin only. */
export async function verifyAuditChain(actor: Actor): Promise<ChainResult> {
  if (actor.role !== "admin") throw new ForbiddenError();
  const rows = await db().select().from(auditEvent).orderBy(asc(auditEvent.id));
  if (rows.length === 0) return { ok: false, id: 0, reason: "audit chain is empty" };
  let prev: string | null = null;
  for (const row of rows) {
    const payload = canonicalAuditPayload({
      id: row.id,
      at: row.at,
      actorId: row.actorId,
      actorRole: row.actorRole,
      action: row.action,
      applicationId: row.applicationId,
      documentId: row.documentId,
      detail: row.detail,
    });
    const expected = auditHash(prev, payload);
    const storedPrev = row.prevHash ? row.prevHash.trim() : null;
    if (storedPrev !== prev) return { ok: false, id: row.id, reason: "prev_hash does not match the previous row" };
    if (row.hash.trim() !== expected) return { ok: false, id: row.id, reason: "hash does not match the payload" };
    prev = row.hash.trim();
  }
  return { ok: true, checked: rows.length };
}

export async function listAuditEvents(
  actor: Actor,
  query: { action?: string; applicationId?: string; limit: number; beforeId?: number },
) {
  if (actor.role !== "admin") throw new ForbiddenError();
  return db()
    .select({
      id: auditEvent.id,
      at: auditEvent.at,
      actorId: auditEvent.actorId,
      actorRole: auditEvent.actorRole,
      action: auditEvent.action,
      applicationId: auditEvent.applicationId,
      documentId: auditEvent.documentId,
      detail: auditEvent.detail,
      prevHash: auditEvent.prevHash,
      hash: auditEvent.hash,
    })
    .from(auditEvent)
    .where(
      and(
        query.action ? eq(auditEvent.action, query.action) : undefined,
        query.applicationId ? eq(auditEvent.applicationId, query.applicationId) : undefined,
        query.beforeId ? lt(auditEvent.id, query.beforeId) : undefined,
      ),
    )
    .orderBy(desc(auditEvent.id))
    .limit(query.limit);
}
