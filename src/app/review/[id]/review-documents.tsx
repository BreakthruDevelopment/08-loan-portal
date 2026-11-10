"use client";

import { useState } from "react";
import { buttonSecondary } from "@/components/ui/styles";
import type { DocumentDto } from "@/lib/dto";
import { formatBytes, formatDateTime } from "@/lib/format";
import { CONTENT_TYPE_LABELS, DOCUMENT_KIND_LABELS, label } from "@/lib/ui-labels";

function Preview({ doc }: { doc: DocumentDto }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-2">
      <button type="button" className={buttonSecondary} aria-expanded={shown} onClick={() => setShown((v) => !v)}>
        {shown ? "Hide preview" : "Preview"}
        <span className="sr-only"> {doc.displayName}</span>
      </button>
      {shown && !failed && (
        // Plain <img>: the file is served by an authenticated route with no-store, so it must not go through the image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/documents/${doc.id}?inline=1`}
          alt={`Preview of ${doc.displayName}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-auto max-h-96 w-full rounded-card border border-border bg-background object-contain"
        />
      )}
      {shown && failed && (
        <p role="alert" className="text-sm text-danger">
          The preview couldn&apos;t be loaded. Download the file instead.
        </p>
      )}
    </div>
  );
}

/**
 * Downloads are plain links to the download route (every underwriter download is audited server-side). Images get an
 * on-demand preview via ?inline=1, so a page view doesn't fetch, and audit, every file. PDFs always download.
 */
export function ReviewDocuments({ documents }: { documents: DocumentDto[] }) {
  if (documents.length === 0) {
    return <p className="text-sm text-muted">This application has no documents.</p>;
  }
  return (
    <ul className="divide-y divide-border" data-documents-count={documents.length}>
      {documents.map((doc) => (
        <li key={doc.id} className="space-y-2 py-3" data-document-id={doc.id} data-document-kind={doc.kind}>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <a
              href={`/api/documents/${doc.id}`}
              download
              className="inline-flex min-h-11 items-center break-all font-medium text-accent hover:underline"
              data-download-link
            >
              {doc.displayName}
              <span className="sr-only"> (download)</span>
            </a>
            <span className="text-sm text-muted">
              {DOCUMENT_KIND_LABELS[doc.kind]} · {label(CONTENT_TYPE_LABELS, doc.contentType)} · {formatBytes(doc.sizeBytes)} · {formatDateTime(doc.uploadedAt)}
            </span>
          </div>
          {doc.contentType !== "application/pdf" && <Preview doc={doc} />}
        </li>
      ))}
    </ul>
  );
}
