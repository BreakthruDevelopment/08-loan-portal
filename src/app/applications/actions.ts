"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAction } from "@/lib/action-run";
import { createApplication, deleteApplication, transitionApplication, updateApplication } from "@/lib/applications";
import { requireRole } from "@/lib/auth/session";
import { deleteDocument } from "@/lib/documents";

/**
 * Applicant server actions. Each one reads the session again (the form can't choose a role), then calls the data
 * function, which checks ownership and the state machine and validates the input with zod.
 */

export async function startApplicationAction(): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireRole("user");
    const row = await createApplication(user, {});
    revalidatePath("/applications");
    return { id: row.id };
  });
}

export async function saveApplicationAction(id: string, patch: Record<string, unknown>): Promise<ActionResult<{ version: number }>> {
  return runAction(async () => {
    const user = await requireRole("user");
    const row = await updateApplication(user, id, patch);
    revalidatePath(`/applications/${id}`);
    return { version: row.version };
  });
}

/** Submit, resubmit (with an optional reply) and withdraw. The state machine decides what is allowed. */
export async function applicantTransitionAction(
  id: string,
  body: { to: "submitted" | "withdrawn"; version: number; message?: string },
): Promise<ActionResult<{ status: string; version: number }>> {
  return runAction(async () => {
    const user = await requireRole("user");
    const row = await transitionApplication(user, id, body);
    revalidatePath(`/applications/${id}`);
    revalidatePath("/applications");
    return { status: row.status, version: row.version };
  });
}

export async function deleteDraftAction(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireRole("user");
    await deleteApplication(user, id);
    revalidatePath("/applications");
    return null;
  });
}

export async function deleteDocumentAction(applicationId: string, documentId: string): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireRole("user");
    await deleteDocument(user, documentId);
    revalidatePath(`/applications/${applicationId}`);
    return null;
  });
}
