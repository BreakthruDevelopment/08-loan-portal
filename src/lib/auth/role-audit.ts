import "server-only";
import { eq } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { appendAudit } from "@/lib/audit";
import { db, schema } from "@/lib/db";
import { isRole, toRole } from "./rbac";

type RoleChange = { userId: string; from: string };

/**
 * Before and after hooks share `ctx.context` (the before hook is invoked with a shallow
 * copy of the request context). The snapshot lives there, not on the copy.
 */
function roleChangeBag(context: object): { roleChange?: RoleChange } {
  return context as { roleChange?: RoleChange };
}

function changedUser(returned: unknown): { id: string; role: string | null } | null {
  if (!returned || typeof returned !== "object" || returned instanceof Response) return null;
  const record = returned as {
    user?: { id?: unknown; role?: unknown };
    response?: { user?: { id?: unknown; role?: unknown } };
  };
  const user = record.user ?? record.response?.user;
  if (!user || typeof user.id !== "string") return null;
  return { id: user.id, role: typeof user.role === "string" ? user.role : null };
}

function sessionActor(session: unknown): { id: string; role: string } | null {
  if (!session || typeof session !== "object") return null;
  const user = (session as { user?: { id?: string; role?: string | null } }).user;
  if (!user?.id) return null;
  return { id: user.id, role: toRole(user.role) };
}

/** Sign-up ignores a role field. set-role accepts one known role name, never a list. */
export const roleAuditBefore = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/sign-up/email" && ctx.body && typeof ctx.body === "object") {
    delete (ctx.body as { role?: unknown }).role;
    return;
  }
  if (ctx.path !== "/admin/set-role") return;
  const body = ctx.body as { userId?: unknown; role?: unknown } | undefined;
  if (!isRole(body?.role)) {
    throw new APIError("BAD_REQUEST", {
      message: "Role must be exactly one of user, underwriter, or admin.",
    });
  }
  const userId = typeof body.userId === "string" ? body.userId : "";
  const [row] = await db()
    .select({ role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  roleChangeBag(ctx.context).roleChange = { userId, from: row?.role ?? "user" };
});

/** A successful role change writes `role.changed`. The detail is ids and role names only. */
export const roleAuditAfter = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/admin/set-role") return;
  const snap = roleChangeBag(ctx.context).roleChange;
  const user = changedUser(ctx.context.returned);
  const actor = sessionActor(ctx.context.session);
  if (!snap || !user || !actor || user.role === snap.from) return;
  const to = user.role ?? "user";
  await db().transaction(async (tx) => {
    await appendAudit(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "role.changed",
      detail: { userId: snap.userId, from: snap.from, to },
    });
  });
});
