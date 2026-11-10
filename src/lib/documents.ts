import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { extensionAgrees, sanitizeDisplayName, sniffContentType } from "@/lib/document-rules";
import { env } from "@/lib/env";
import { ConflictError, HttpError, NotFoundError, PayloadTooLargeError } from "@/lib/errors";
import { type DocumentKind, MAX_BYTES_PER_APPLICATION, MAX_FILE_BYTES, MAX_FILES_PER_APPLICATION, isEditableStatus, parseUuid } from "@/lib/loan";
import { advisoryLock } from "@/lib/usage";

/**
 * Store one document for the applicant who owns an editable application.
 * The HTTP upload route (a later issue) adds the content-length and PDF hygiene checks
 * before it calls this. List queries read `document` and never `document_blob`.
 */
export async function addDocument(
  actor: Actor,
  applicationId: string,
  input: { kind: DocumentKind; displayName: string; bytes: Uint8Array },
) {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  const id = parseUuid(applicationId);
  const kind = input.kind;
  const displayName = sanitizeDisplayName(input.displayName);
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new PayloadTooLargeError(MAX_FILE_BYTES);
  const contentType = sniffContentType(bytes);
  if (!contentType) throw new HttpError(415, "Upload a PDF, PNG, or JPEG.");
  if (!extensionAgrees(displayName, contentType)) throw new HttpError(415, "The file extension doesn't match its contents.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return db().transaction(async (tx) => {
    await advisoryLock(tx, "doc-storage");
    const [row] = await tx
      .select()
      .from(schema.application)
      .where(and(eq(schema.application.id, id), eq(schema.application.applicantId, actor.id)));
    if (!row) throw new NotFoundError();
    if (!isEditableStatus(row.status)) throw new ConflictError("Documents can be changed while the application is editable.");

    const existing = await tx
      .select({ sizeBytes: schema.document.sizeBytes, sha256: schema.document.sha256 })
      .from(schema.document)
      .where(and(eq(schema.document.applicationId, id), isNull(schema.document.deletedAt)));
    if (existing.some((doc) => doc.sha256 === sha256)) throw new ConflictError("That file is already on this application.");
    if (existing.length >= MAX_FILES_PER_APPLICATION) throw new ConflictError("This application already has 8 files.");
    const used = existing.reduce((sum, doc) => sum + doc.sizeBytes, 0);
    if (used + bytes.byteLength > MAX_BYTES_PER_APPLICATION) {
      throw new ConflictError("This application is over its 20 MB document limit.");
    }
    const [total] = await tx.execute<{ bytes: string }>(
      sql`select coalesce(sum(size_bytes), 0)::text as bytes from document where deleted_at is null`,
    );
    const cap = env().DOC_STORAGE_CAP_MB * 1024 * 1024;
    if (Number(total.bytes) + bytes.byteLength > cap) throw new ConflictError("Document storage is full. Uploads are paused.");

    const [doc] = await tx
      .insert(schema.document)
      .values({
        applicationId: id,
        applicantId: actor.id,
        kind,
        displayName,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256,
      })
      .returning();
    await tx.insert(schema.documentBlob).values({ documentId: doc.id, bytes });
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "document.uploaded",
      applicationId: id,
      documentId: doc.id,
      detail: { kind, contentType },
    });
    return doc;
  });
}
