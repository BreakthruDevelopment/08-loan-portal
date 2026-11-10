import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { BadRequestError, HttpError, PayloadTooLargeError, RequestTimeoutError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

export type ErrorInfo = { status: number; body: { error: string; issues?: unknown }; headers?: Record<string, string> };

/** Map known errors to a status and a client-safe body; never leak stack traces or internals. */
export function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof HttpError && err.retryAfterSeconds !== undefined) {
    return { status: err.status, body: { error: err.message }, headers: { "Retry-After": String(err.retryAfterSeconds) } };
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    };
  }
  if (err instanceof AiError) {
    const status = err.kind === "input_rejected" ? 400 : err.kind === "quota" ? 429 : 502;
    return { status, body: { error: err.message } };
  }
  // Never log `err.message` here: database errors embed the query parameters (emails, note text, keys).
  log.error("request.failed", safeErrorFields(err));
  return { status: 500, body: { error: "Something went wrong" } };
}

export function errorResponse(err: unknown): Response {
  const { status, body, headers } = errorInfo(err);
  return Response.json(body, { status, headers });
}

/** Default cap for JSON bodies: small forms and upload requests. Pass a bigger `limit` per route if you need it. */
export const JSON_BODY_LIMIT = 16 * 1024;

/**
 * Read the request body exactly once, as bytes, refusing anything over `limit` bytes.
 * Checks Content-Length first, then counts while streaming so a lying header can't get past.
 */
export async function readBodyCapped(request: Request, limit: number, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // One deadline for the whole body (not per chunk), so a slow trickle can't hold the request open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    opts.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RequestTimeoutError()), opts.timeoutMs);
        });
  deadline?.catch(() => undefined);
  try {
    for (;;) {
      const next = reader.read();
      const { done, value } = await (deadline ? Promise.race([next, deadline]) : next);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new PayloadTooLargeError(limit);
      chunks.push(value);
    }
  } catch (err) {
    // Not awaited: on a stalled connection a cancel can wait as long as the read did.
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/** Parse a UTF-8 JSON body; 400 when it isn't valid JSON. */
export function parseJsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestError("Body must be valid JSON");
  }
}

/** Capped read plus JSON parse: 413 when too large, 400 when not JSON. */
export async function readJson(request: Request, limit: number = JSON_BODY_LIMIT): Promise<unknown> {
  return parseJsonBody(await readBodyCapped(request, limit));
}

/** A Buffer as a fetch body without copying it (a typed view over the same memory). */
export function bodyOf(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}
