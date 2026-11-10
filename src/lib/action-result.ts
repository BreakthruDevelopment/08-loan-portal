import type { Failure } from "@/lib/api-errors";

/** What a server action hands back to a client component. Errors are data, so the form can show them and offer a refresh. */
export type ActionResult<T = null> = { ok: true; data: T } | ({ ok: false } & Failure);
