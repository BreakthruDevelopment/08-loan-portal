import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, parseJsonBody, readBodyCapped, JSON_BODY_LIMIT } from "@/lib/http";
import { generateRiskView, getRiskView } from "@/lib/risk";

export const dynamic = "force-dynamic";
// A live model call can take up to AI_TIMEOUT_MS (20 s).
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/applications/:id/risk — underwriters only, submitted applications only; applicants and admins get 404.
 * Returns the rule metrics and flags (always) and the cached AI summary if it still matches. No model call.
 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ risk: await getRiskView(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/applications/:id/risk — body optional: { regenerate?: boolean }.
 * Returns the cached summary for this version of the application, or generates one.
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    const bytes = await readBodyCapped(request, JSON_BODY_LIMIT);
    const body = bytes.length === 0 ? {} : parseJsonBody(bytes);
    return Response.json({ risk: await generateRiskView(user, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
