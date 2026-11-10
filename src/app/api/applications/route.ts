import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createApplication, listApplications } from "@/lib/applications";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/applications — the caller's own applications. Underwriters get 403. Admins get 404. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ applications: await listApplications(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/applications — create a draft. Body is a partial application, or {}. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const application = await createApplication(user, await readJson(request));
    return Response.json({ application }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
