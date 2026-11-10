import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { addNote, listNotes } from "@/lib/notes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/applications/:id/notes — applicants see applicant-visible notes. Underwriters see all. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ notes: await listNotes(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/applications/:id/notes — body { body, visibility? }. Applicants cannot write internal notes. */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    const note = await addNote(user, id, await readJson(request));
    return Response.json({ note }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
