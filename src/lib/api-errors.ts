/**
 * Turn a failed request (a route's status and body, or a server action's error) into one sentence a person can act on.
 * Client-safe. The server's own message is used when it is specific; the size and time-out statuses get fixed wording
 * because the server's text for them is generic.
 */

export type Failure = {
  status: number;
  message: string;
  /** The application or summary changed under the user: show a "load the latest" button. */
  stale: boolean;
  retryAfterSeconds: number | null;
};

export const MAX_UPLOAD_MB = 5;

/** Retry-After is seconds or an HTTP date. Returns whole seconds (at least 1), or null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Math.max(1, Number(trimmed));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

function waitHint(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 90) return ` Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  return ` Try again in about ${Math.ceil(seconds / 60)} minutes.`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function describeFailure(input: { status: number; message?: string | null; retryAfterSeconds?: number | null }): Failure {
  const { status } = input;
  const server = input.message?.trim() ? sentence(input.message) : "";
  const retry = input.retryAfterSeconds ?? null;
  const make = (message: string, stale = false): Failure => ({ status, message, stale, retryAfterSeconds: retry });

  if (status === 0) return make("Couldn't reach the server. Check your connection and try again.");
  if (status === 401) return make("Your session has ended. Sign in again to continue.");
  if (status === 403) return make(server || "You don't have permission to do that.");
  if (status === 404) return make("That wasn't found. It may have been removed, or it isn't yours to open.");
  if (status === 408) return make(`${server || "The upload took too long."} Try again on a faster connection.`);
  if (status === 409) {
    const text = server || "That change isn't allowed right now.";
    return make(text, /updated|changed/i.test(text));
  }
  if (status === 411) return make("Your browser didn't send the file size, so the upload was refused. Try another browser.");
  if (status === 413) return make(`That file is too big. Files can be up to ${MAX_UPLOAD_MB} MB.`);
  if (status === 415) {
    const base = server || "That file type isn't accepted.";
    return make(/PDF, PNG/.test(base) ? base : `${base} Use a PDF, PNG or JPEG.`);
  }
  if (status === 422) return make(server || "That file was refused.");
  if (status === 429) return make(`${server || "Too many requests."}${waitHint(retry)}`);
  if (status === 503) return make(`${server || "The server is busy."}${waitHint(retry)}`);
  if (status === 400) return make(server && server !== "Invalid input." ? server : "Some of those values aren't valid. Check them and try again.");
  if (status >= 500) return make("Something went wrong on our side. Try again in a moment.");
  return make(server || "That didn't work. Try again.");
}

/** Check a file in the browser before sending it: the size cap is the only thing worth refusing early. */
export function precheckUpload(file: { name: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `That file is too big. Files can be up to ${MAX_UPLOAD_MB} MB.`;
  return null;
}
