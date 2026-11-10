import { BadRequestError } from "@/lib/errors";
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
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
    .trim();
  if (!cleaned) throw new BadRequestError("The file needs a name.");
  return cleaned;
}

/** When the display name has an extension, it has to agree with the sniffed type. */
export function extensionAgrees(displayName: string, type: StoredContentType): boolean {
  const dot = displayName.lastIndexOf(".");
  if (dot <= 0 || dot === displayName.length - 1) return true;
  const ext = displayName.slice(dot + 1).toLowerCase();
  return EXTENSIONS[type].includes(ext);
}
