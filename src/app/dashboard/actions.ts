"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createApplication, deleteApplication } from "@/lib/applications";

/** Applicants start a draft. The session is read again here; the form cannot choose a role. */
export async function createDraftAction(): Promise<void> {
  const user = await requireUser();
  await createApplication(user, {});
  revalidatePath("/dashboard");
}

export async function deleteDraftAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await deleteApplication(user, String(form.get("id") ?? ""));
  revalidatePath("/dashboard");
}
