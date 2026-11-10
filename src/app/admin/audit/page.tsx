import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { type Column, DataList, FilterBar, PageIntro, Panel } from "@/components/ui";
import { listAuditEvents } from "@/lib/audit";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatDateTime, shortId } from "@/lib/format";
import { VerifyChain } from "./verify-chain";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const ACTIONS = [
  "application.created",
  "application.updated",
  "application.submitted",
  "application.claimed",
  "application.released",
  "application.info_requested",
  "application.decided",
  "application.withdrawn",
  "application.viewed",
  "document.uploaded",
  "document.deleted",
  "document.downloaded",
  "risk_summary.generated",
  "role.changed",
  "audit.genesis",
];

const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await requireRoleOrRedirect("admin");
  const query = await searchParams;
  const action = ACTIONS.includes(first(query.action) ?? "") ? first(query.action) : undefined;
  const rawApplication = first(query.applicationId)?.trim() || undefined;
  const applicationId = rawApplication && z.string().uuid().safeParse(rawApplication).success ? rawApplication : undefined;
  const badApplication = Boolean(rawApplication) && !applicationId;
  const beforeParsed = z.coerce.number().int().positive().safeParse(first(query.beforeId));
  const beforeId = beforeParsed.success ? beforeParsed.data : undefined;

  const fetched = await listAuditEvents(admin, { action, applicationId, beforeId, limit: PAGE_SIZE + 1 });
  const events = fetched.slice(0, PAGE_SIZE);
  const more = fetched.length > PAGE_SIZE;
  type Row = (typeof events)[number];

  const nextParams = new URLSearchParams();
  if (action) nextParams.set("action", action);
  if (applicationId) nextParams.set("applicationId", applicationId);
  if (events.length > 0) nextParams.set("beforeId", String(events[events.length - 1].id));

  const columns: Column<Row>[] = [
    { key: "id", header: "Event", primary: true, className: "whitespace-nowrap font-mono", cell: (e) => `#${e.id}` },
    { key: "at", header: "When", className: "whitespace-nowrap", cell: (e) => formatDateTime(e.at) },
    { key: "action", header: "Action", cell: (e) => <span className="break-all font-mono text-sm">{e.action}</span> },
    {
      key: "actor",
      header: "Actor",
      cell: (e) => (
        <span className="break-all">
          {e.actorRole} <span className="font-mono text-sm text-muted">{shortId(e.actorId)}</span>
        </span>
      ),
    },
    { key: "application", header: "Application", cell: (e) => <span className="font-mono text-sm">{shortId(e.applicationId)}</span> },
    { key: "document", header: "Document", cell: (e) => <span className="font-mono text-sm">{shortId(e.documentId)}</span> },
    {
      key: "detail",
      header: "Detail",
      cell: (e) => <code className="break-all text-sm">{Object.keys(e.detail ?? {}).length === 0 ? "—" : JSON.stringify(e.detail)}</code>,
    },
    { key: "hash", header: "Hash", cell: (e) => <span className="font-mono text-sm text-muted">{e.hash.trim().slice(0, 12)}</span> },
  ];

  return (
    <div data-page="admin-audit">
      <PageIntro
        section="Audit log"
        title="Audit log"
        description="Metadata only: field names, statuses, reason codes and ids. Amounts, names, file names and note text are never recorded."
      />
      <Panel title="Verify the chain">
        <p className="mb-3 text-sm text-muted">
          Every event stores a hash of the one before it. Verifying walks the whole chain and reports the first event that was edited or removed.
        </p>
        <VerifyChain />
      </Panel>
      <Panel title="Events" count={events.length}>
        <FilterBar
          label="Filter the audit log"
          search={{ name: "applicationId", value: rawApplication, placeholder: "Application id (uuid)" }}
          filters={[
            {
              name: "action",
              label: "Action",
              value: action ?? "",
              options: [{ value: "", label: "All actions" }, ...ACTIONS.map((a) => ({ value: a, label: a }))],
            },
          ]}
        />
        {badApplication && (
          <p role="alert" className="mb-3 text-sm font-medium text-danger">
            That isn&apos;t an application id, so it was ignored. Use the full uuid.
          </p>
        )}
        <div data-audit-table data-audit-count={events.length}>
          <DataList caption="Audit events, newest first" rows={events} rowKey={(e) => String(e.id)} columns={columns} empty="No events match." />
        </div>
        {more && (
          <p className="mt-4">
            <Link href={`/admin/audit?${nextParams.toString()}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline" data-audit-older>
              Older events →
            </Link>
          </p>
        )}
      </Panel>
    </div>
  );
}
