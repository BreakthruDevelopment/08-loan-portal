import "server-only";
import { desc } from "drizzle-orm";
import { type Actor, ForbiddenError, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";

/**
 * Accounts for the admin's role screen: who they are (so a role can be granted) and what role they hold.
 * No application, document or financial data is joined here: admins manage accounts, not files.
 */
export async function listUsers(actor: Actor, limit = 100) {
  if (actor.role !== "admin") throw new ForbiddenError();
  const rows = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      banned: schema.user.banned,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => ({ ...row, role: toRole(row.role), banned: Boolean(row.banned) }));
}
