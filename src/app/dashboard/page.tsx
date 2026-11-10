import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Everyone's home is their own desk: applicants, the queue, or the admin counts. */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  if (user.role === "admin") redirect("/admin");
  if (user.role === "underwriter") redirect("/queue");
  redirect("/applications");
}
