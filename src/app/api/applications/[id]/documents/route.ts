import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { addDocument, listDocuments } from "@/lib/documents";
import { HttpError, PayloadTooLargeError } from "@/lib/errors";
import { errorResponse, readBodyCapped } from "@/lib/http";
import { DOCUMENT_KINDS, MAX_FILE_BYTES } from "@/lib/loan";

export const dynamic = "force-dynamic";

/** 5 MB of file plus multipart framing. Checked from Content-Length before reading, then again while streaming. */
export const UPLOAD_BODY_LIMIT = MAX_FILE_BYTES + 512 * 1024;

type Ctx = { params: Promise<{ id: string }> };

const uploadForm = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  file: z.instanceof(File),
});

/** GET /api/applications/:id/documents: metadata only (never bytes). Owner, or an underwriter once submitted. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ documents: await listDocuments(user, id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/applications/:id/documents: multipart with `kind` and one `file`. A missing Content-Length is 411 and
 * an oversize one is 413, both before any byte is read; the read itself is capped while streaming too.
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;

    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new HttpError(415, "Send the file as multipart/form-data.");
    const length = request.headers.get("content-length");
    if (length === null || length.trim() === "") throw new HttpError(411, "Content-Length is required.");
    if (!/^\d{1,12}$/.test(length.trim())) throw new HttpError(400, "Invalid Content-Length.");
    if (Number(length) > UPLOAD_BODY_LIMIT) throw new PayloadTooLargeError(UPLOAD_BODY_LIMIT);

    const body = await readBodyCapped(request, UPLOAD_BODY_LIMIT);
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new HttpError(400, "The upload couldn't be read.");
    }
    if (form.getAll("file").length !== 1) throw new HttpError(400, "Send exactly one file.");
    const fields = uploadForm.parse({ kind: form.get("kind"), file: form.get("file") });

    const document = await addDocument(user, id, {
      kind: fields.kind,
      displayName: fields.file.name,
      bytes: new Uint8Array(await fields.file.arrayBuffer()),
    });
    return Response.json({ document }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
