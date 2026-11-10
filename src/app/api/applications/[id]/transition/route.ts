import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { transitionApplication } from "@/lib/applications";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/applications/:id/transition — body { to, version, message?, codes?, note? }. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    const application = await transitionApplication(user, id, await readJson(request));
    return Response.json({ application });
  } catch (err) {
    return errorResponse(err);
  }
}
