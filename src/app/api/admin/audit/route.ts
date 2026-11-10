import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { listAuditEvents } from "@/lib/audit";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  action: z.string().max(80).optional(),
  applicationId: z.string().uuid().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/admin/audit — metadata only. Filters: action, applicationId, beforeId, limit. */
export async function GET(request: Request) {
  try {
    const user = await requireRole("admin");
    const url = new URL(request.url);
    const query = querySchema.parse({
      action: url.searchParams.get("action") ?? undefined,
      applicationId: url.searchParams.get("applicationId") ?? undefined,
      beforeId: url.searchParams.get("beforeId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const events = await listAuditEvents(user, query);
    return Response.json({
      events: events.map((event) => ({
        ...event,
        prevHash: event.prevHash ? event.prevHash.trim() : null,
        hash: event.hash.trim(),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
