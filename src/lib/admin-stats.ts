import "server-only";
import { count, isNull, sql } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { APPLICATION_STATUSES, DOCUMENT_KINDS } from "@/lib/loan";

/** Counts and storage only. No application ids, names, amounts, or document names. */
export async function adminStats(actor: Actor) {
  if (actor.role !== "admin") throw new ForbiddenError();
  const statusRows = await db()
    .select({ status: schema.application.status, n: count() })
    .from(schema.application)
    .groupBy(schema.application.status);
  const applicationsByStatus = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0])) as Record<
    (typeof APPLICATION_STATUSES)[number],
    number
  >;
  for (const row of statusRows) applicationsByStatus[row.status] = Number(row.n);

  const kindRows = await db()
    .select({ kind: schema.document.kind, n: count() })
    .from(schema.document)
    .where(isNull(schema.document.deletedAt))
    .groupBy(schema.document.kind);
  const documentsByKind = Object.fromEntries(DOCUMENT_KINDS.map((kind) => [kind, 0])) as Record<
    (typeof DOCUMENT_KINDS)[number],
    number
  >;
  for (const row of kindRows) documentsByKind[row.kind] = Number(row.n);

  const [storage] = await db().execute<{ bytes: string }>(
    sql`select coalesce(sum(size_bytes), 0)::text as bytes from document where deleted_at is null`,
  );
  const capBytes = env().DOC_STORAGE_CAP_MB * 1024 * 1024;
  return {
    applicationsByStatus,
    documentsByKind,
    documentCount: Object.values(documentsByKind).reduce((sum, n) => sum + n, 0),
    storageUsedBytes: Number(storage?.bytes ?? 0),
    storageCapBytes: capBytes,
  };
}
