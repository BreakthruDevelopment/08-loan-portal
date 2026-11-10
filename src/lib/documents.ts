import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { canReadApplication, contentWhere } from "@/lib/access";
import { appendAudit } from "@/lib/audit";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import {
  type StoredContentType,
  assertPdfHygiene,
  extensionAgrees,
  sanitizeDisplayName,
  sniffContentType,
} from "@/lib/document-rules";
import { env } from "@/lib/env";
import { ConflictError, HttpError, NotFoundError, PayloadTooLargeError } from "@/lib/errors";
import { log } from "@/lib/log";
import {
  type DocumentKind,
  DOCUMENT_KINDS,
  MAX_BYTES_PER_APPLICATION,
  MAX_FILE_BYTES,
  MAX_FILES_PER_APPLICATION,
  type ApplicationStatus,
  isEditableStatus,
  parseUuid,
} from "@/lib/loan";
import { advisoryLock, consumeRate } from "@/lib/usage";

/** Uploads per applicant per hour. Failed attempts roll back with their transaction and don't count. */
export const UPLOADS_PER_HOUR = 30;

const doc = schema.document;
const app = schema.application;

/** What a client may see about a document. Never the hash, the owner id, or the bytes. */
const PUBLIC_COLUMNS = {
  id: doc.id,
  applicationId: doc.applicationId,
  kind: doc.kind,
  displayName: doc.displayName,
  contentType: doc.contentType,
  sizeBytes: doc.sizeBytes,
  uploadedAt: doc.uploadedAt,
} as const;

export type DocumentSummary = {
  /** Whether the viewer can delete it now: owner, application editable, and not part of an earlier submission. */
  deletable: boolean;
  id: string;
  applicationId: string;
  kind: DocumentKind;
  displayName: string;
  contentType: StoredContentType;
  sizeBytes: number;
  uploadedAt: Date;
};

type DeleteContext = { status: ApplicationStatus; submittedAt: Date | null };

/**
 * The delete rule, once: editable application, and a file uploaded before the latest submission is locked (the
 * underwriter may have read it). Callers check ownership.
 */
function deleteRule(app_: DeleteContext, uploadedAt: Date): "ok" | "not_editable" | "submitted_file" {
  if (!isEditableStatus(app_.status)) return "not_editable";
  if (app_.submittedAt && uploadedAt <= app_.submittedAt) return "submitted_file";
  return "ok";
}

export function parseDocumentKind(value: unknown): DocumentKind {
  if (typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value)) return value as DocumentKind;
  throw new HttpError(400, "Choose a document type.");
}

/**
 * Charge one upload against the applicant's hourly limit in its own committed transaction. The route calls this
 * before it reads the body, so refused and failed attempts count and a rejected upload can't be retried for free.
 * Throws 429 at the limit; 404 for admin and 403 for underwriters (the same answers `addDocument` gives).
 */
export async function chargeUpload(actor: Actor): Promise<void> {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  await db().transaction((tx) => consumeRate(tx, actor.id, "upload", UPLOADS_PER_HOUR, "Too many uploads. Try again later."));
}

/**
 * Store one document for the applicant who owns an editable application. Every content rule lives here, so a
 * caller other than the HTTP route can't skip one: size, type by content, extension, PDF hygiene, then (in one
 * transaction under advisory locks) the per-application and app-wide caps. List queries read `document` and
 * never `document_blob`.
 */
export async function addDocument(
  actor: Actor,
  applicationId: string,
  input: { kind: DocumentKind; displayName: string; bytes: Uint8Array },
  /** `rateCharged: true` when the caller already ran `chargeUpload`, so one upload is never charged twice. */
  opts: { rateCharged?: boolean } = {},
): Promise<DocumentSummary> {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  const id = parseUuid(applicationId);
  const kind = parseDocumentKind(input.kind);
  const displayName = sanitizeDisplayName(input.displayName);
  // A view, not a copy: the caller's buffer is already a full file in memory.
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (bytes.byteLength === 0) throw new HttpError(400, "The file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new PayloadTooLargeError(MAX_FILE_BYTES);
  const contentType = sniffContentType(bytes);
  if (!contentType) throw new HttpError(415, "Upload a PDF, PNG, or JPEG.");
  if (!extensionAgrees(displayName, contentType)) throw new HttpError(415, "The file extension doesn't match its contents.");
  if (contentType === "application/pdf") assertPdfHygiene(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return db().transaction(async (tx) => {
    // Same lock a transition takes, so an upload can't slip in after a submit. Order is always
    // application, then storage, so two uploads can't deadlock.
    await advisoryLock(tx, `application:${id}`);
    const [row] = await tx.select().from(app).where(and(eq(app.id, id), eq(app.applicantId, actor.id)));
    if (!row) throw new NotFoundError();
    if (!isEditableStatus(row.status)) throw new ConflictError("Documents can be changed while the application is editable.");
    if (!opts.rateCharged) await consumeRate(tx, actor.id, "upload", UPLOADS_PER_HOUR, "Too many uploads. Try again later.");
    await advisoryLock(tx, "doc-storage");

    const existing = await tx
      .select({ sizeBytes: doc.sizeBytes, sha256: doc.sha256 })
      .from(doc)
      .where(and(eq(doc.applicationId, id), isNull(doc.deletedAt)));
    if (existing.some((d) => d.sha256 === sha256)) throw new ConflictError("That file is already on this application.");
    if (existing.length >= MAX_FILES_PER_APPLICATION) throw new ConflictError("This application already has 8 files.");
    const used = existing.reduce((sum, d) => sum + d.sizeBytes, 0);
    if (used + bytes.byteLength > MAX_BYTES_PER_APPLICATION) {
      throw new ConflictError("This application is over its 20 MB document limit.");
    }
    // Fails closed: if the sum can't be read the upload errors, and at the cap it is refused.
    const [total] = await tx.execute<{ bytes: string }>(
      sql`select coalesce(sum(size_bytes), 0)::text as bytes from document where deleted_at is null`,
    );
    const cap = env().DOC_STORAGE_CAP_MB * 1024 * 1024;
    if (!total || !(Number(total.bytes) + bytes.byteLength <= cap)) {
      throw new ConflictError("Document storage is full. Uploads are paused.");
    }

    const [created] = await tx
      .insert(doc)
      .values({ applicationId: id, applicantId: actor.id, kind, displayName, contentType, sizeBytes: bytes.byteLength, sha256 })
      .returning(PUBLIC_COLUMNS);
    await tx.insert(schema.documentBlob).values({ documentId: created.id, bytes });
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "document.uploaded",
      applicationId: id,
      documentId: created.id,
      detail: { kind, contentType, sizeBytes: bytes.byteLength },
    });
    log.info("document.uploaded", { applicationId: id, documentId: created.id, kind, sizeBytes: bytes.byteLength });
    return { ...created, deletable: true } as DocumentSummary;
  });
}

/** Metadata for one application's live documents. Same visibility as the application. Never selects `bytes`. */
export async function listDocuments(actor: Actor, applicationId: string): Promise<DocumentSummary[]> {
  if (actor.role === "admin") throw new NotFoundError();
  const id = parseUuid(applicationId);
  const [row] = await db().select().from(app).where(and(eq(app.id, id), contentWhere(actor)));
  if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
  const rows = await db()
    .select(PUBLIC_COLUMNS)
    .from(doc)
    .where(and(eq(doc.applicationId, id), isNull(doc.deletedAt)))
    .orderBy(asc(doc.uploadedAt));
  const owner = actor.role === "user" && row.applicantId === actor.id;
  return rows.map((r) => ({ ...r, deletable: owner && deleteRule(row, r.uploadedAt) === "ok" })) as DocumentSummary[];
}

export type DocumentContent = {
  id: string;
  contentType: StoredContentType;
  bytes: Buffer;
  /** True only when inline was asked for and the type is an image. PDFs always download. */
  inline: boolean;
};

/**
 * The only function that reads `document_blob`. Owner, or an underwriter once the file is submitted; admin and
 * everyone else get 404. The download is audited in the same transaction, so no audit row means no bytes.
 */
export async function getDocumentContent(actor: Actor, documentId: string, opts: { inline?: boolean } = {}): Promise<DocumentContent> {
  if (actor.role === "admin") throw new NotFoundError();
  const id = parseUuid(documentId);
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: doc.id,
        applicationId: doc.applicationId,
        kind: doc.kind,
        contentType: doc.contentType,
        applicantId: app.applicantId,
        status: app.status,
        submittedAt: app.submittedAt,
      })
      .from(doc)
      .innerJoin(app, and(eq(app.id, doc.applicationId), eq(app.applicantId, doc.applicantId)))
      .where(and(eq(doc.id, id), isNull(doc.deletedAt), contentWhere(actor)));
    if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
    const [blob] = await tx
      .select({ bytes: schema.documentBlob.bytes })
      .from(schema.documentBlob)
      .where(eq(schema.documentBlob.documentId, id));
    if (!blob) throw new NotFoundError();
    // The stored type was sniffed at upload; if the bytes no longer agree, don't serve them.
    if (sniffContentType(blob.bytes) !== row.contentType) {
      log.error("document.type_mismatch", { documentId: id });
      throw new NotFoundError();
    }
    const inline = opts.inline === true && row.contentType !== "application/pdf";
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "document.downloaded",
      applicationId: row.applicationId,
      documentId: id,
      detail: { kind: row.kind, contentType: row.contentType, inline },
    });
    return { id, contentType: row.contentType, bytes: blob.bytes, inline };
  });
}

/**
 * Soft-delete a document and drop its bytes at once. Owner only, while the application is editable. In
 * `info_requested` a file the underwriter may already have read (uploaded before the latest submission) is locked;
 * only files added since the request can be removed.
 */
export async function deleteDocument(actor: Actor, documentId: string): Promise<void> {
  if (actor.role === "admin") throw new NotFoundError();
  if (actor.role !== "user") throw new ForbiddenError();
  const id = parseUuid(documentId);
  const [found] = await db()
    .select({ applicationId: doc.applicationId })
    .from(doc)
    .where(and(eq(doc.id, id), eq(doc.applicantId, actor.id), isNull(doc.deletedAt)));
  if (!found) throw new NotFoundError();

  await db().transaction(async (tx) => {
    await advisoryLock(tx, `application:${found.applicationId}`);
    const [row] = await tx
      .select({
        id: doc.id,
        kind: doc.kind,
        uploadedAt: doc.uploadedAt,
        status: app.status,
        submittedAt: app.submittedAt,
      })
      .from(doc)
      .innerJoin(app, and(eq(app.id, doc.applicationId), eq(app.applicantId, doc.applicantId)))
      .where(and(eq(doc.id, id), eq(doc.applicantId, actor.id), isNull(doc.deletedAt)));
    if (!row) throw new NotFoundError();
    const rule = deleteRule(row, row.uploadedAt);
    if (rule === "not_editable") throw new ConflictError("Documents can be changed while the application is editable.");
    if (rule === "submitted_file") throw new ConflictError("This file was part of the submission and can't be removed.");
    await tx.update(doc).set({ deletedAt: new Date() }).where(eq(doc.id, id));
    await tx.delete(schema.documentBlob).where(eq(schema.documentBlob.documentId, id));
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "document.deleted",
      applicationId: found.applicationId,
      documentId: id,
      detail: { kind: row.kind },
    });
  });
}
