import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { appendAudit } from "@/lib/audit";
import { db, schema } from "@/lib/db";
import { isDemoEmail } from "@/lib/demo-identity";
import { log } from "@/lib/log";
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

const DEMO_IMAGE_PREFIX = "urn:breakthru:";

function bodyOf(ctx: { body?: unknown }): Record<string, unknown> {
  return ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
}

/** `image` carries the demo loader's marker, so a public user must never be able to write one. */
function isDemoMarker(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith(DEMO_IMAGE_PREFIX);
}

/**
 * Every role change goes through /admin/set-role, which is audited. So:
 * - sign-up drops any role and refuses demo-domain emails and the demo marker in `image`;
 * - /admin/create-user and /admin/update-user refuse a role (top-level or in `data`), which would
 *   otherwise grant one (even a list like ["user","underwriter"]) with no `role.changed` row;
 * - /update-user and the admin variants refuse the demo marker in `image`;
 * - /admin/set-role accepts exactly one known role name, never a list.
 */
export const roleAuditBefore = createAuthMiddleware(async (ctx) => {
  const body = bodyOf(ctx);
  switch (ctx.path) {
    case "/sign-up/email": {
      delete body.role;
      if (isDemoEmail(body.email)) {
        throw new APIError("BAD_REQUEST", { message: "That email address can't be used to sign up." });
      }
      if (isDemoMarker(body.image)) throw new APIError("BAD_REQUEST", { message: "That profile image isn't allowed." });
      return;
    }
    case "/update-user": {
      if (isDemoMarker(body.image)) throw new APIError("BAD_REQUEST", { message: "That profile image isn't allowed." });
      return;
    }
    case "/admin/create-user":
    case "/admin/update-user": {
      const data = dataOf(body);
      if (body.role !== undefined || data.role !== undefined) {
        throw new APIError("BAD_REQUEST", { message: "Change roles with set-role so the change is audited." });
      }
      if (isDemoMarker(data.image) || isDemoMarker(body.image)) {
        throw new APIError("BAD_REQUEST", { message: "That profile image isn't allowed." });
      }
      return;
    }
    case "/admin/set-role":
      break;
    default:
      return;
  }
  if (!isRole(body.role)) {
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
  // Ordering note: Better Auth commits the role update inside its own endpoint, before this hook runs, and
  // exposes no way to join our transaction. So the audit row is written right after, in its own transaction.
  // If that write fails the request returns an error even though the role changed; that is logged loudly
  // and the admin sees the failure rather than a silent unaudited grant.
  try {
    await db().transaction(async (tx) => {
      await appendAudit(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: "role.changed",
        detail: { userId: snap.userId, from: snap.from, to },
      });
      // Someone who stops being an underwriter can no longer act on files they claimed, and nobody else can
      // act on them while the assignment stands. Return those files to the queue, one audit row each.
      if (snap.from === "underwriter" && to !== "underwriter") {
        const released = await tx
          .update(schema.application)
          .set({
            status: "submitted",
            assignedUnderwriterId: null,
            version: sql`${schema.application.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.application.assignedUnderwriterId, snap.userId), eq(schema.application.status, "in_review")))
          .returning({ id: schema.application.id });
        for (const file of released) {
          await appendAudit(tx, {
            actorId: actor.id,
            actorRole: actor.role,
            action: "application.released",
            applicationId: file.id,
            detail: { from: "in_review", to: "submitted", reason: "assignee_role_changed" },
          });
        }
      }
    });
  } catch (err) {
    log.error("role.audit_failed", { targetUserId: snap.userId, from: snap.from, to });
    throw err;
  }
});
