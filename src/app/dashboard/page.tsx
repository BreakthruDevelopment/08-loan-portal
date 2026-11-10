import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile, buttonDanger, buttonPrimary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { adminStats } from "@/lib/admin-stats";
import { listApplications, listQueue } from "@/lib/applications";
import { createDraftAction, deleteDraftAction } from "./actions";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function formatMoney(cents: number | null) {
  if (cents === null) return "—";
  return money.format(cents / 100);
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

export default async function DashboardPage() {
  const user = await requireUserOrRedirect();

  if (user.role === "admin") {
    const stats = await adminStats(user);
    const open =
      stats.applicationsByStatus.draft +
      stats.applicationsByStatus.submitted +
      stats.applicationsByStatus.in_review +
      stats.applicationsByStatus.info_requested;
    return (
      <>
        <PageIntro
          section="Dashboard"
          title={`Hi, ${user.name}`}
          description={`Signed in as ${user.email}. Role: admin. Counts only — application contents stay with applicants and underwriters.`}
        />
        <StatGrid>
          <StatTile value={open} label="Open applications" tone="accent" />
          <StatTile value={stats.documentCount} label="Documents" />
          <StatTile value={`${Math.round(stats.storageUsedBytes / (1024 * 1024))} MB`} label="Storage used" />
          <StatTile value={`${Math.round(stats.storageCapBytes / (1024 * 1024))} MB`} label="Storage cap" />
        </StatGrid>
      </>
    );
  }

  if (user.role === "underwriter") {
    const [fresh, mine, decided] = await Promise.all([
      listQueue(user, "new"),
      listQueue(user, "mine"),
      listQueue(user, "decided"),
    ]);
    return (
      <>
        <PageIntro
          section="Queue"
          title={`Hi, ${user.name}`}
          description="Submitted applications only. Drafts stay with the applicant. The full review desk is a later page."
        />
        <StatGrid>
          <StatTile value={fresh.length} label="New" tone="accent" />
          <StatTile value={mine.length} label="Mine" />
          <StatTile value={decided.length} label="Decided" />
        </StatGrid>
      </>
    );
  }

  const applications = await listApplications(user);
  type Row = (typeof applications)[number];
  const columns: Column<Row>[] = [
    {
      key: "status",
      header: "Status",
      primary: true,
      cell: (row) => <span className="font-semibold capitalize">{formatStatus(row.status)}</span>,
    },
    { key: "amount", header: "Amount", cell: (row) => formatMoney(row.amountCents) },
    { key: "purpose", header: "Purpose", cell: (row) => row.purpose?.replaceAll("_", " ") ?? "—" },
    {
      key: "updated",
      header: "Updated",
      className: "whitespace-nowrap",
      cell: (row) => row.updatedAt.toISOString().slice(0, 10),
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      hideLabel: true,
      className: "text-right",
      cell: (row) =>
        row.status === "draft" ? (
          <form action={deleteDraftAction}>
            <input type="hidden" name="id" value={row.id} />
            <button type="submit" className={buttonDanger}>
              Delete draft
            </button>
          </form>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];

  return (
    <>
      <PageIntro
        section="Applications"
        title={`Hi, ${user.name}`}
        description={`Signed in as ${user.email}. You can have up to 3 open applications.`}
        actions={
          <form action={createDraftAction}>
            <button type="submit" className={buttonPrimary}>
              Start an application
            </button>
          </form>
        }
      />
      <StatGrid>
        <StatTile value={applications.length} label="Your applications" tone="accent" />
        <StatTile value={applications.filter((row) => row.status === "draft").length} label="Drafts" />
      </StatGrid>
      <Panel title="Your applications" count={applications.length}>
        <DataList
          caption="Your applications"
          rows={applications}
          rowKey={(row) => row.id}
          columns={columns}
          empty="No applications yet. Start one when you're ready."
        />
      </Panel>
    </>
  );
}
