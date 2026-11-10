import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { verifyAuditChain } from "@/lib/audit";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/audit/verify — walk the hash chain and report the first broken link. */
export async function POST(request: Request) {
  try {
    const user = await requireRole("admin");
    requireSameOrigin(request);
    return Response.json({ result: await verifyAuditChain(user) });
  } catch (err) {
    return errorResponse(err);
  }
}
