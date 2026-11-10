import { type Failure, describeFailure, parseRetryAfter, precheckUpload } from "@/lib/api-errors";
import type { DocumentKind } from "@/lib/loan";

export type UploadResult = { ok: true } | ({ ok: false } & Failure);

/**
 * POST one file to the upload route with progress. XMLHttpRequest (not fetch) because only it reports upload
 * progress. The browser sets Content-Length and the multipart boundary; the Origin header is sent for same-origin POSTs.
 * The route's refusals (411, 413, 415, 422, 429 with Retry-After, 408 and the rest) come back as a Failure.
 */
export function uploadDocument(
  applicationId: string,
  kind: DocumentKind,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const early = precheckUpload(file);
  if (early) return Promise.resolve({ ok: false, ...describeFailure({ status: file.size === 0 ? 422 : 413, message: early }), message: early });

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/applications/${encodeURIComponent(applicationId)}/documents`);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve({ ok: true });
        return;
      }
      let message: string | null = null;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // A non-JSON body (a proxy's error page) gets the status-based wording.
      }
      resolve({
        ok: false,
        ...describeFailure({
          status: xhr.status,
          message,
          retryAfterSeconds: parseRetryAfter(xhr.getResponseHeader("Retry-After")),
        }),
      });
    };
    // A server that answers early and closes the connection looks like a network error to the browser.
    xhr.onerror = () => resolve({ ok: false, ...describeFailure({ status: 0 }) });
    xhr.ontimeout = () => resolve({ ok: false, ...describeFailure({ status: 408 }) });
    xhr.onabort = () => resolve({ ok: false, ...describeFailure({ status: 0, message: "The upload was cancelled." }), message: "The upload was cancelled." });
    xhr.timeout = 120_000;
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file, file.name);
    xhr.send(form);
  });
}
