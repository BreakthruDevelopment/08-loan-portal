import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { toRole } from "@/lib/auth/rbac";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { adminStats } from "@/lib/admin-stats";
import { db, schema } from "@/lib/db";
import { DemoButton } from "./demo-button";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

function roleLabel(role: string | null) {
  const resolved = toRole(role);
  if (resolved === "admin") {
    return <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span>;
  }
  if (resolved === "underwriter") {
    return (
      <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Underwriter</span>
    );
  }
  return "Applicant";
}

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const stats = await adminStats(admin);
  const users = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(100);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => roleLabel(u.role),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.toISOString().slice(0, 10),
    },
  ];

  return (
    <>
      <PageIntro
        section="Admin"
        title="Users"
        description="Everyone who has signed up, newest first. Application contents are not shown here. Ban an account that still has an open file; deleting it is refused."
      />
      <StatGrid>
        <StatTile value={users.length} label="Users" tone="accent" />
        <StatTile value={users.filter((u) => toRole(u.role) === "admin").length} label="Admins" />
        <StatTile value={users.filter((u) => toRole(u.role) === "underwriter").length} label="Underwriters" />
        <StatTile value={stats.documentCount} label="Documents" />
      </StatGrid>
      <Panel title="Demo workspace">
        <p className="mb-3 text-muted">
          Loads two applicants, three applications, one underwriter, and one admin. It refuses a production host.
        </p>
        <DemoButton />
      </Panel>
      <Panel title="All users" count={users.length}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}
