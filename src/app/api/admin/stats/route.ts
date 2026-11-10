import { requireRole } from "@/lib/auth/session";
import { adminStats } from "@/lib/admin-stats";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats — counts and storage. No application contents. */
export async function GET() {
  try {
    const user = await requireRole("admin");
    return Response.json({ stats: await adminStats(user) });
  } catch (err) {
    return errorResponse(err);
  }
}
