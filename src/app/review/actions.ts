"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAction } from "@/lib/action-run";
import { transitionApplication } from "@/lib/applications";
import { requireRole } from "@/lib/auth/session";
import { addNote } from "@/lib/notes";

/** Underwriter server actions. Assignment, state and reason-code rules are enforced by the data functions. */

export type ReviewTransition =
  | { to: "in_review"; version: number }
  | { to: "submitted"; version: number }
  | { to: "info_requested"; version: number; message: string }
  | { to: "approved"; version: number; note?: string }
  | { to: "declined"; version: number; codes: string[]; note?: string };

export async function reviewTransitionAction(
  id: string,
  body: ReviewTransition,
): Promise<ActionResult<{ status: string; version: number }>> {
  return runAction(async () => {
    const user = await requireRole("underwriter");
    const row = await transitionApplication(user, id, body);
    revalidatePath(`/review/${id}`);
    revalidatePath("/queue");
    return { status: row.status, version: row.version };
  });
}

export async function addReviewNoteAction(
  id: string,
  input: { body: string; visibility: "internal" | "applicant" },
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireRole("underwriter");
    await addNote(user, id, input);
    revalidatePath(`/review/${id}`);
    return null;
  });
}
