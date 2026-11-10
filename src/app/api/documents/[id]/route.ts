import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { downloadFilename } from "@/lib/document-rules";
import { deleteDocument, getDocumentContent } from "@/lib/documents";
import { bodyOf, errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const query = z.object({ inline: z.literal("1").optional() }).strict();

/**
 * GET /api/documents/:id: the owner, or an underwriter once the file is submitted; everyone else (admin included) 404.
 * Always an attachment with a name built from the id, never from the upload. `?inline=1` shows PNG and JPEG only.
 * The response can't run script or be framed (CSP sandbox, nosniff, same-origin resource policy).
 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { inline } = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const file = await getDocumentContent(user, id, { inline: inline === "1" });
    return new Response(bodyOf(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `${file.inline ? "inline" : "attachment"}; filename="${downloadFilename(file.id, file.contentType)}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/documents/:id: owner, while the application is editable. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    await deleteDocument(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
