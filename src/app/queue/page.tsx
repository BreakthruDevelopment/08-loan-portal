import type { Metadata } from "next";
import Link from "next/link";
import { ApplicationStatusBadge } from "@/components/status-pill";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { listQueue } from "@/lib/applications";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatCents, formatDate, shortId } from "@/lib/format";
import { PURPOSE_LABELS, label } from "@/lib/ui-labels";

export const metadata: Metadata = { title: "Underwriting queue" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "new", label: "New", empty: "Nothing is waiting. New submissions appear here." },
  { id: "orphaned", label: "Orphaned", empty: "No orphaned files. A file is orphaned when its underwriter is gone; release it to put it back in New." },
  { id: "mine", label: "Mine", empty: "You aren't holding any files. Claim one from New." },
  { id: "decided", label: "Decided", empty: "No decisions yet." },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRoleOrRedirect("underwriter");
  const query = await searchParams;
  const tabParam = typeof query.tab === "string" ? query.tab : "new";
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "new";
  const sort = query.sort === "newest" ? "newest" : "oldest";

  const [unclaimed, mine, decided] = await Promise.all([listQueue(user, "new"), listQueue(user, "mine"), listQueue(user, "decided")]);
  // The data layer's "new" list is every file nobody can act on: submitted, or in review with no live assignee.
  const lists = {
    new: unclaimed.filter((r) => r.status === "submitted"),
    orphaned: unclaimed.filter((r) => r.status === "in_review"),
    mine,
    decided,
  };
  const rows = [...lists[tab]].sort((a, b) => {
    const diff = (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0);
    return sort === "oldest" ? diff : -diff;
  });
  type Row = (typeof rows)[number];

  const columns: Column<Row>[] = [
    {
      key: "application",
      header: "Application",
      primary: true,
      cell: (row) => (
        <Link
          href={`/review/${row.id}`}
          className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline"
          data-application-id={row.id}
        >
          {formatCents(row.amountCents)} <span className="ml-2 font-mono text-sm font-normal text-muted">#{shortId(row.id)}</span>
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
    { key: "term", header: "Term", className: "whitespace-nowrap", cell: (row) => (row.termMonths ? `${row.termMonths} mo` : "—") },
    { key: "submitted", header: "Submitted", className: "whitespace-nowrap", cell: (row) => formatDate(row.submittedAt) },
  ];

  return (
    <div data-page="queue" data-queue-tab={tab}>
      <PageIntro
        section="Queue"
        title="Underwriting queue"
        description="Submitted applications only. Drafts stay private to the applicant."
      />
      <StatGrid>
        <StatTile value={lists.new.length} label="New" tone="accent" />
        <StatTile value={lists.mine.length} label="Mine" />
        <StatTile value={lists.orphaned.length} label="Orphaned" tone={lists.orphaned.length > 0 ? "building" : "default"} />
        <StatTile value={lists.decided.length} label="Decided" />
      </StatGrid>
      <nav aria-label="Queue tabs" className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/queue?tab=${t.id}&sort=${sort}`}
            aria-current={t.id === tab ? "page" : undefined}
            data-queue-link={t.id}
            data-count={lists[t.id].length}
            className={`inline-flex min-h-11 items-center gap-2 rounded-card border px-4 text-sm font-semibold ${
              t.id === tab ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground hover:bg-accent-soft"
            }`}
          >
            {t.label}
            <span className="rounded-md bg-background px-1.5 text-xs text-foreground">{lists[t.id].length}</span>
          </Link>
        ))}
      </nav>
      <Panel title={TABS.find((t) => t.id === tab)?.label ?? "New"} count={rows.length}>
        <FilterBar
          label="Sort the queue"
          hidden={{ tab }}
          sort={{
            name: "sort",
            label: "Sort by submitted date",
            value: sort,
            options: [
              { value: "oldest", label: "Oldest submitted first" },
              { value: "newest", label: "Newest submitted first" },
            ],
          }}
        />
        <DataList
          caption={`${TABS.find((t) => t.id === tab)?.label} applications`}
          rows={rows}
          rowKey={(row) => row.id}
          columns={columns}
          empty={TABS.find((t) => t.id === tab)?.empty}
        />
      </Panel>
    </div>
  );
}
