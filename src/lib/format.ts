/**
 * Display helpers that are safe to run in the browser and on the server, so a value looks the same in both.
 * Money is always integer cents: nothing here multiplies or divides a dollar float.
 */

/** 150000 -> "$1,500.00". Null, undefined and non-finite values show an em dash. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const whole = Math.trunc(cents);
  const abs = Math.abs(whole);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${whole < 0 ? "-" : ""}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export type MoneyParse = { ok: true; cents: number | null } | { ok: false };

const DOLLARS = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * "1,500", "$1500.5" or "1500.50" -> integer cents, by string arithmetic (no floats).
 * An empty string is a valid "not entered yet" (cents: null). Anything else that isn't money is `{ ok: false }`.
 */
export function parseDollarsToCents(input: string): MoneyParse {
  const text = input.trim();
  if (text === "") return { ok: true, cents: null };
  const match = DOLLARS.exec(text);
  if (!match) return { ok: false };
  const dollars = Number(match[1].replaceAll(",", ""));
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = dollars * 100 + fraction;
  if (!Number.isSafeInteger(cents)) return { ok: false };
  return { ok: true, cents };
}

/** Cents -> the text a person would type back: 150000 -> "1500", 150050 -> "1500.50". Null -> "". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const whole = Math.trunc(cents);
  const dollars = Math.floor(whole / 100);
  const remainder = whole % 100;
  return remainder === 0 ? String(dollars) : `${dollars}.${String(remainder).padStart(2, "0")}`;
}

/** Whole non-negative integers only ("24"). Empty is "not entered yet". */
export function parseWholeNumber(input: string): { ok: true; value: number | null } | { ok: false } {
  const text = input.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d{1,9}$/.test(text)) return { ok: false };
  return { ok: true, value: Number(text) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-11-10". UTC, so the server and the browser agree. */
export function formatDate(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? date.toISOString().slice(0, 10) : "—";
}

/** "2026-11-10 16:28 UTC". */
export function formatDateTime(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC` : "—";
}

/** The first 8 characters of an id, for tables where the full uuid would overflow a phone. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
