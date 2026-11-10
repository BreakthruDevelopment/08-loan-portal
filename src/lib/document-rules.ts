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
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
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

/**
 * Names that mean script, launch, attachment, form submission or import, remote go-to, rich media, or password
 * protection. `/URI` is deliberately not here: links are ordinary in statements.
 */
const FORBIDDEN_PDF_NAMES = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "XFA",
  "Encrypt",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "GoToE",
]);

export const PDF_REFUSED_MESSAGE = "PDFs with scripts, attachments or passwords aren't accepted.";

/** PDF whitespace: NUL, tab, LF, FF, CR, space. Readers end a name at any of these, so the scanner must too. */
const isPdfSpace = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
/** PDF delimiters: ( ) < > [ ] { } / % */
const isPdfDelimiter = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

/** A forbidden name is at most 14 characters, 42 bytes if every one is written as `#xx`. Longer tokens can't match. */
const MAX_NAME_BYTES = 48;

const hexValue = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x41 + 10 : c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : -1);

/** Decode `#xx` escapes in a collected name's bytes. */
function decodeName(raw: number[]): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const hi = raw[i] === 0x23 && i + 2 < raw.length ? hexValue(raw[i + 1]) : -1;
    const lo = hi >= 0 ? hexValue(raw[i + 2]) : -1;
    if (hi >= 0 && lo >= 0) {
      out += String.fromCharCode(hi * 16 + lo);
      i += 2;
    } else out += String.fromCharCode(raw[i]);
  }
  return out;
}

/**
 * Heuristic active-content check for PDFs. It walks the bytes once (no copy of the file as a string) and looks for
 * the forbidden names as whole name tokens, after decoding `#xx` escapes (`/Java#53cript` is `/JavaScript`), ending
 * a name at any PDF whitespace (including NUL and form feed) or delimiter, so `/JSON` doesn't match `/JS` and
 * `/Encrypt\0 5 0 R` does match. It cannot see names inside compressed object streams, so it reduces risk and
 * doesn't prove a file is safe; files also aren't scanned for malware.
 */
export function assertPdfHygiene(bytes: Uint8Array): void {
  const refuse = () => {
    throw new UnprocessableError(PDF_REFUSED_MESSAGE);
  };
  const raw: number[] = [];
  let inName = false;
  let tooLong = false;
  const finish = () => {
    if (inName && !tooLong && FORBIDDEN_PDF_NAMES.has(decodeName(raw))) refuse();
    inName = false;
    tooLong = false;
    raw.length = 0;
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i];
    if (c === 0x2f) {
      finish();
      inName = true;
    } else if (inName) {
      if (isPdfSpace(c) || isPdfDelimiter(c)) finish();
      else if (!tooLong) {
        if (raw.length >= MAX_NAME_BYTES) tooLong = true;
        else raw.push(c);
      }
    }
  }
  finish();
}

/** Safe download name: built from the id and the sniffed type only, never from the uploaded name. */
export function downloadFilename(id: string, type: StoredContentType): string {
  const ext = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg";
  return `document-${id}.${ext}`;
}
