import { BadRequestError, UnprocessableError } from "@/lib/errors";
import { matchesMagic, type MagicType } from "@/lib/magic";

export type StoredContentType = "application/pdf" | "image/png" | "image/jpeg";

const EXTENSIONS: Record<StoredContentType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
};

/** Type by content. WebP and anything else are refused; the stored type is the sniffed one. */
export function sniffContentType(bytes: Uint8Array): StoredContentType | null {
  const types: StoredContentType[] = ["application/pdf", "image/png", "image/jpeg"];
  return types.find((type) => matchesMagic(type as MagicType, bytes)) ?? null;
}

/** Display only. Control characters and path separators never reach storage. */
export function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .toWellFormed()
    // Control characters, plus zero-width and bidi-override characters that disguise an extension.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[/\\]/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) throw new BadRequestError("The file needs a name.");
  return truncateKeepingExtension(cleaned, 120);
}

/** A long name is cut in the middle, so the extension (which the type check needs) survives. */
function truncateKeepingExtension(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 11 ? name.slice(dot) : "";
  return (name.slice(0, max - ext.length).trimEnd() + ext).toWellFormed();
}

/** The display name needs an extension and it has to agree with the sniffed type. */
export function extensionAgrees(displayName: string, type: StoredContentType): boolean {
  const dot = displayName.lastIndexOf(".");
  if (dot <= 0 || dot === displayName.length - 1) return false;
  const ext = displayName.slice(dot + 1).toLowerCase();
  return EXTENSIONS[type].includes(ext);
}

/** Names that mean script, launch, attachment, form-script, rich-media or password protection. */
const FORBIDDEN_PDF_NAMES = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "XFA",
  "Encrypt",
]);

/** A PDF name token: `/` then regular characters (no whitespace or delimiters). */
const PDF_NAME = /\/[^\s/<>[\](){}%]+/g;

export const PDF_REFUSED_MESSAGE = "PDFs with scripts, attachments or passwords aren't accepted.";

/**
 * Heuristic active-content check for PDFs. It looks for the forbidden names as whole name tokens, after decoding
 * `#xx` escapes (`/Java#53cript` is `/JavaScript`), so `/JSON` doesn't match `/JS`. It cannot see names inside
 * compressed object streams, so it reduces risk and doesn't prove a file is safe; files also aren't scanned for malware.
 */
export function assertPdfHygiene(bytes: Uint8Array): void {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  for (const match of text.matchAll(PDF_NAME)) {
    const raw = match[0].slice(1);
    const name = raw.includes("#") ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : raw;
    if (FORBIDDEN_PDF_NAMES.has(name)) throw new UnprocessableError(PDF_REFUSED_MESSAGE);
  }
}

/** Safe download name: built from the id and the sniffed type only, never from the uploaded name. */
export function downloadFilename(id: string, type: StoredContentType): string {
  const ext = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg";
  return `document-${id}.${ext}`;
}
