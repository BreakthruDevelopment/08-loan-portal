"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Field } from "@/components/field";
import { FailureNote } from "@/components/feedback";
import { type Column, DataList, buttonDanger, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui";
import type { Failure } from "@/lib/api-errors";
import type { DocumentDto } from "@/lib/dto";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_KINDS, MAX_BYTES_PER_APPLICATION, MAX_FILES_PER_APPLICATION, type DocumentKind } from "@/lib/loan";
import { CONTENT_TYPE_LABELS, DOCUMENT_KIND_LABELS, label } from "@/lib/ui-labels";
import { uploadDocument } from "@/lib/upload-client";
import { deleteDocumentAction } from "../actions";

function DeleteDocumentButton({ applicationId, doc }: { applicationId: string; doc: DocumentDto }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  if (!confirming) {
    return (
      <button type="button" className={buttonDanger} onClick={() => setConfirming(true)}>
        Delete<span className="sr-only"> {doc.displayName}</span>
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonDanger}
          disabled={pending}
          onClick={() =>
            start(async () => {
              setFailure(null);
              const result = await deleteDocumentAction(applicationId, doc.id);
              if (!result.ok) return setFailure(result);
              router.refresh();
            })
          }
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </button>
        <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setConfirming(false)}>
          Keep
        </button>
      </div>
      <FailureNote failure={failure} onRefresh={() => router.refresh()} />
    </div>
  );
}

/** The document list with per-file delete (only where the server says `deletable`) and the upload form with progress. */
export function DocumentsManager({ applicationId, documents }: { applicationId: string; documents: DocumentDto[] }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const uploading = progress !== null;

  const columns: Column<DocumentDto>[] = [
    {
      key: "name",
      header: "File",
      primary: true,
      cell: (doc) => (
        <a
          href={`/api/documents/${doc.id}`}
          download
          className="inline-flex min-h-11 items-center break-all font-medium text-accent hover:underline"
        >
          {doc.displayName}
        </a>
      ),
    },
    { key: "kind", header: "Type", cell: (doc) => DOCUMENT_KIND_LABELS[doc.kind] },
    { key: "format", header: "Format", cell: (doc) => label(CONTENT_TYPE_LABELS, doc.contentType) },
    { key: "size", header: "Size", className: "whitespace-nowrap", cell: (doc) => formatBytes(doc.sizeBytes) },
    { key: "uploaded", header: "Added", className: "whitespace-nowrap", cell: (doc) => formatDateTime(doc.uploadedAt) },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      hideLabel: true,
      className: "text-right",
      cell: (doc) =>
        doc.deletable ? (
          <span data-document-id={doc.id} data-deletable="true">
            <DeleteDocumentButton applicationId={applicationId} doc={doc} />
          </span>
        ) : (
          <span data-document-id={doc.id} data-deletable="false" className="text-sm text-muted">
            Locked: part of your submission
          </span>
        ),
    },
  ];

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    const kind = String(data.get("kind") ?? "") as DocumentKind;
    setFailure(null);
    setDone(null);
    setFileError(undefined);
    if (!(file instanceof File) || (file.size === 0 && file.name === "")) {
      setFileError("Choose a file to upload.");
      return;
    }
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      setFailure({ status: 400, message: "Choose a document type.", stale: false, retryAfterSeconds: null });
      return;
    }
    setProgress(0);
    const result = await uploadDocument(applicationId, kind, file, setProgress);
    setProgress(null);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setDone(`Added ${file.name}.`);
    form.reset();
    router.refresh();
  }

  return (
    <div className="space-y-6" data-documents-count={documents.length}>
      <DataList
        caption="Your documents"
        rows={documents}
        rowKey={(doc) => doc.id}
        columns={columns}
        empty="No documents yet. Add an identification document and a pay stub, bank statement or tax return."
      />
      <form ref={formRef} onSubmit={onSubmit} className="space-y-4 rounded-card border border-border bg-background p-4" aria-label="Upload a document" noValidate>
        <h3 className="font-semibold">Add a document</h3>
        <p className="text-sm text-muted" id="upload-hint">
          PDF, PNG or JPEG, up to 5 MB each. Up to {MAX_FILES_PER_APPLICATION} files and {MAX_BYTES_PER_APPLICATION / (1024 * 1024)} MB per
          application. Files aren&apos;t scanned for malware, and PDFs with scripts, attachments or passwords are refused. Use demo files only.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="doc-kind" label="Document type">
            {(p) => (
              <select name="kind" defaultValue="id" className={inputClass} disabled={uploading} {...p}>
                {DOCUMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {DOCUMENT_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="doc-file" label="File" error={fileError}>
            {(p) => (
              <input
                type="file"
                name="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                disabled={uploading}
                className={`${inputClass} file:mr-3 file:rounded-card file:border-0 file:bg-accent-soft file:px-3 file:py-1 file:text-accent`}
                {...p}
                aria-describedby={[p["aria-describedby"], "upload-hint"].filter(Boolean).join(" ")}
              />
            )}
          </Field>
        </div>
        {uploading && (
          <div className="space-y-1" role="status">
            <progress value={Math.round((progress ?? 0) * 100)} max={100} aria-label="Upload progress" className="h-3 w-full accent-accent" />
            <p className="text-sm text-muted">Uploading… {Math.round((progress ?? 0) * 100)}%</p>
          </div>
        )}
        <FailureNote failure={failure} onRefresh={() => router.refresh()} />
        {done && (
          <p role="status" className="text-sm font-medium text-success">
            {done}
          </p>
        )}
        <button type="submit" className={buttonPrimary} disabled={uploading}>
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </form>
    </div>
  );
}
