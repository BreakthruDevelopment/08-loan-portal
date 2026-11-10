import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile, buttonSecondary } from "@/components/ui";
import { adminStats } from "@/lib/admin-stats";
import { listUsers } from "@/lib/admin-users";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatBytes, formatDate } from "@/lib/format";
import { APPLICATION_STATUSES, DOCUMENT_KINDS } from "@/lib/loan";
import { DOCUMENT_KIND_LABELS, STATUS_LABELS } from "@/lib/ui-labels";
import { DemoButton } from "./demo-button";
import { RoleSelect } from "./role-select";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const [stats, users] = await Promise.all([adminStats(admin), listUsers(admin)]);
  const used = stats.storageUsedBytes;
  const cap = stats.storageCapBytes;
  const percent = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const totalApplications = APPLICATION_STATUSES.reduce((sum, s) => sum + stats.applicationsByStatus[s], 0);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => <span className="break-words">{u.name}</span> },
    { key: "email", header: "Email", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => <RoleSelect userId={u.id} name={u.name} role={u.role} self={u.id === admin.id} />,
    },
    { key: "status", header: "Account", cell: (u) => (u.banned ? "Banned" : "Active") },
    { key: "joined", header: "Joined", className: "whitespace-nowrap", cell: (u) => formatDate(u.createdAt) },
  ];

  return (
    <div data-page="admin">
      <PageIntro
        section="Admin"
        title="Counts, storage and roles"
        description="Counts only. Application contents and documents are never shown here."
        actions={
          <Link href="/admin/audit" className={buttonSecondary}>
            Open the audit log
          </Link>
        }
      />

      <Panel title="Applications by status" count={totalApplications}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-status-counts>
          {APPLICATION_STATUSES.map((status) => (
            <div key={status} className="rounded-card border border-border bg-background px-4 py-3" data-status-count={status}>
              <p className="font-display text-3xl font-semibold leading-none">{stats.applicationsByStatus[status]}</p>
              <p className="mt-1 text-sm text-muted">{STATUS_LABELS[status]}</p>
            </div>
          ))}
        </div>
      </Panel>

      <StatGrid>
        <StatTile value={stats.documentCount} label="Documents" tone="accent" />
        <StatTile value={users.length} label="Users" />
        <StatTile value={users.filter((u) => u.role === "underwriter").length} label="Underwriters" />
        <StatTile value={users.filter((u) => u.role === "admin").length} label="Admins" />
      </StatGrid>

      <Panel title="Document storage">
        <div className="space-y-2" data-storage>
          <progress value={percent} max={100} aria-label="Document storage used" className="h-3 w-full accent-accent" />
          <p className="text-sm">
            {formatBytes(used)} used of {formatBytes(cap)} ({percent}%).
          </p>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            {DOCUMENT_KINDS.map((kind) => (
              <li key={kind} data-document-kind-count={kind}>
                {DOCUMENT_KIND_LABELS[kind]}: {stats.documentsByKind[kind]}
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel title="Demo workspace">
        <p className="mb-3 text-muted">
          Loads two applicants, three applications, one underwriter and one admin. It refuses a production host.
        </p>
        <DemoButton />
      </Panel>

      <Panel title="Users and roles" count={users.length}>
        <p className="mb-3 text-sm text-muted">
          Roles change through the role select only, and each change is written to the audit log. Underwriters get no admin powers.
          An account that still has an open file can&apos;t be deleted: ban it instead.
        </p>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </div>
  );
}
