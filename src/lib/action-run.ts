import "server-only";
import { describeFailure } from "@/lib/api-errors";
import type { ActionResult } from "@/lib/action-result";
import { errorInfo } from "@/lib/http";
import { parseRetryAfter } from "@/lib/api-errors";

/**
 * Run a data function for a server action and turn any known error into a result the form can display.
 * Unknown errors are logged by `errorInfo` (without the message) and shown as a generic failure.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const info = errorInfo(err);
    const issues = (info.body.issues as { message?: string }[] | undefined) ?? [];
    return {
      ok: false,
      ...describeFailure({
        status: info.status,
        message: issues.length > 0 ? null : info.body.error,
        retryAfterSeconds: parseRetryAfter(info.headers?.["Retry-After"]),
      }),
    };
  }
}
