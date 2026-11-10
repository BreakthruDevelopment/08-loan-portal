import { DECISION_CODES, type DecisionCode } from "@/lib/loan";

export const MAX_DECISION_CODES = 4;
export const NOTE_MAX = 1000;

export type DeclineCheck = { ok: true; codes: DecisionCode[]; note: string } | { ok: false; message: string };

/**
 * The decline dialog's rules, checked in the browser before the request (the server checks them again):
 * 1 to 4 distinct reason codes from the fixed list, OTHER needs a note, the note is at most 1,000 characters.
 */
export function validateDecline(codes: readonly string[], note: string): DeclineCheck {
  const unique = [...new Set(codes)];
  const known = unique.filter((c): c is DecisionCode => (DECISION_CODES as readonly string[]).includes(c));
  if (known.length !== unique.length) return { ok: false, message: "Choose reason codes from the list." };
  if (known.length < 1) return { ok: false, message: "Choose at least one reason code." };
  if (known.length > MAX_DECISION_CODES) return { ok: false, message: `Choose at most ${MAX_DECISION_CODES} reason codes.` };
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) return { ok: false, message: `The note can be up to ${NOTE_MAX} characters.` };
  if (known.includes("OTHER") && trimmed === "") return { ok: false, message: "OTHER needs a note explaining the reason." };
  return { ok: true, codes: known, note: trimmed };
}

export function validateMessage(message: string): { ok: true; message: string } | { ok: false; message: string } {
  const trimmed = message.trim();
  if (trimmed === "") return { ok: false, message: "Tell the applicant what you need." };
  if (trimmed.length > NOTE_MAX) return { ok: false, message: `The message can be up to ${NOTE_MAX} characters.` };
  return { ok: true, message: trimmed };
}
