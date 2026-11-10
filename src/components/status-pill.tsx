import { StatusBadge } from "@/components/ui";
import type { ApplicationStatus } from "@/lib/loan";
import { STATUS_LABELS, STATUS_TONES } from "@/lib/ui-labels";

/** An application's status as the shared badge, with the label as text so colour is never the only signal. */
export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return <StatusBadge status={STATUS_TONES[status]} label={STATUS_LABELS[status]} />;
}
