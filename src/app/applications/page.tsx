import type { Metadata } from "next";
import Link from "next/link";
import { ApplicationStatusBadge } from "@/components/status-pill";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { listApplications } from "@/lib/applications";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatCents, formatDate } from "@/lib/format";
import { OPEN_APPLICATION_CAP, isFinalStatus } from "@/lib/loan";
import { PURPOSE_LABELS, label } from "@/lib/ui-labels";
import { DeleteDraftButton } from "./delete-draft-button";
import { StartApplicationButton } from "./start-button";

export const metadata: Metadata = { title: "Your applications" };
export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const user = await requireRoleOrRedirect("user");
  const applications = await listApplications(user);
  type Row = (typeof applications)[number];
  const open = applications.filter((row) => !isFinalStatus(row.status)).length;

  const columns: Column<Row>[] = [
    {
      key: "application",
      header: "Application",
      primary: true,
      cell: (row) => (
        <Link
          href={`/applications/${row.id}`}
          className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline"
          data-application-link={row.id}
        >
          {row.amountCents === null ? "New application" : formatCents(row.amountCents)}
          <span className="sr-only"> (open)</span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <span data-application-status={row.status}>
          <ApplicationStatusBadge status={row.status} />
        </span>
      ),
    },
    { key: "purpose", header: "Purpose", cell: (row) => label(PURPOSE_LABELS, row.purpose) },
    { key: "updated", header: "Updated", className: "whitespace-nowrap", cell: (row) => formatDate(row.updatedAt) },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      hideLabel: true,
      className: "text-right",
      cell: (row) => (row.status === "draft" ? <DeleteDraftButton id={row.id} /> : null),
    },
  ];

  return (
    <div data-page="applications">
      <PageIntro
        section="Applications"
        title="Your loan applications"
        description={`Start an application, add your documents and send it in. You can have up to ${OPEN_APPLICATION_CAP} open applications.`}
        actions={
          <StartApplicationButton
            disabledReason={open >= OPEN_APPLICATION_CAP ? `You have ${OPEN_APPLICATION_CAP} open applications. Finish or withdraw one first.` : undefined}
          />
        }
      />
      <StatGrid>
        <StatTile value={applications.length} label="Applications" tone="accent" />
        <StatTile value={open} label="Open" />
        <StatTile value={applications.filter((row) => row.status === "info_requested").length} label="Need your reply" tone="building" />
      </StatGrid>
      <Panel title="Applications" count={applications.length}>
        <DataList
          caption="Your applications"
          rows={applications}
          rowKey={(row) => row.id}
          columns={columns}
          empty="No applications yet. Start one when you're ready."
        />
      </Panel>
    </div>
  );
}
