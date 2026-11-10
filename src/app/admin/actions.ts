"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/rbac";
import { assertDemoTargetAllowed } from "@/lib/demo-seed-config";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
import { HttpError } from "@/lib/errors";

export type DemoActionState = { error?: string; ok?: boolean };

/** Admin-only. The password is random and is not returned or logged. */
export async function loadDemoAction(prev: DemoActionState): Promise<DemoActionState> {
  void prev;
  try {
    const user = await requireRole("admin");
    try {
      assertDemoTargetAllowed();
    } catch (err) {
      throw new ForbiddenError(err instanceof Error ? err.message : "Demo seed refused.");
    }
    const password = randomBytes(24).toString("base64url");
    await loadDemoWorkspace({ actor: user, actorEmail: user.email, password });
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof HttpError) return { error: err.message };
    throw err;
  }
}
