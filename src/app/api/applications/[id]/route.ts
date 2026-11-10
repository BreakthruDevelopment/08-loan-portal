import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteApplication, getApplication, updateApplication } from "@/lib/applications";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/applications/:id — owner, or an underwriter once it is no longer a draft. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ application: await getApplication(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/applications/:id — owner, while the file is editable. Body includes version. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    const application = await updateApplication(user, id, await readJson(request));
    return Response.json({ application });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/applications/:id — owner, drafts only. A submitted file is 409. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    await deleteApplication(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
