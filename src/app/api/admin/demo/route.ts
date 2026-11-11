import { randomBytes } from "node:crypto";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { assertDemoTargetAllowed } from "@/lib/demo-seed-config";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { ForbiddenError } from "@/lib/auth/rbac";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo — rebuild the demo workspace. The generated password is not returned. */
export async function POST(request: Request) {
  try {
    const user = await requireRole("admin");
    requireSameOrigin(request);
    try {
      assertDemoTargetAllowed(process.env, { ownApp: true });
    } catch (err) {
      throw new ForbiddenError(err instanceof Error ? err.message : "Demo seed refused.");
    }
    const password = randomBytes(24).toString("base64url");
    const result = await loadDemoWorkspace({ actor: user, actorEmail: user.email, password });
    return Response.json({ loaded: result.loaded, applications: result.applications });
  } catch (err) {
    return errorResponse(err);
  }
}
