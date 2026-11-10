/**
 * Access rules and the state machine against Postgres. Skips when TEST_DATABASE_URL is unset.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PDF, DEMO_PNG } from "@/lib/demo-files";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";

const complete = {
  amountCents: 1_500_000,
  termMonths: 36 as const,
  purpose: "debt_consolidation" as const,
  employmentStatus: "employed" as const,
  employerName: "Northwind",
  monthsEmployed: 24,
  annualIncomeCents: 6_000_000,
  monthlyHousingCents: 120_000,
  monthlyDebtCents: 30_000,
  creditBand: "good" as const,
};

describe.skipIf(!url)("loan access, state machine, and audit (Postgres)", () => {
  let sql: postgres.Sql;
  const ada = { id: "ln-ada", role: "user" as const };
  const ben = { id: "ln-ben", role: "user" as const };
  const quinn = { id: "ln-quinn", role: "underwriter" as const };
  const riley = { id: "ln-riley", role: "underwriter" as const };
  const admin = { id: "ln-admin", role: "admin" as const };
  const people = [ada, ben, quinn, riley, admin];
  let seq = 0;

  async function makeUser(role: "user" | "underwriter" | "admin" = "user") {
    seq += 1;
    const id = `ln-x${seq}`;
    await sql`insert into "user" (id, name, email, role) values (${id}, ${id}, ${`${id}@test.local`}, ${role})`;
    return { id, role };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from application where applicant_id like 'ln-%'`;
    await sql`delete from "user" where id like 'ln-%' or email like 'ln-%@test.local' or email like '%@demo.breakthru.test'`;
    for (const person of people) {
      await sql`insert into "user" (id, name, email, role) values (${person.id}, ${person.id}, ${person.id + "@test.local"}, ${person.role})`;
    }
  });

  afterAll(async () => {
    await sql`delete from application where applicant_id like 'ln-%' or applicant_id in (select id from "user" where email like '%@demo.breakthru.test')`;
    await sql`delete from "user" where id like 'ln-%' or email like 'ln-%@test.local' or email like '%@demo.breakthru.test'`;
    await sql.end();
  });

  async function auditDetail(applicationId: string, action: string) {
    const rows = await sql<{ detail: { message?: string; note?: string; codes?: string[]; fields?: string[] } }[]>`
      select detail from audit_event where application_id = ${applicationId} and action = ${action} order by id desc limit 1
    `;
    return rows[0]?.detail;
  }

  it("hides other applicants' files, drafts from underwriters, and every file from admins", async () => {
    const { createApplication, getApplication, listApplications, updateApplication, deleteApplication, transitionApplication } =
      await import("@/lib/applications");
    const { listNotes } = await import("@/lib/notes");
    const { addDocument } = await import("@/lib/documents");
    const owner = await makeUser();
    const other = await makeUser();
    const draft = await createApplication(owner, { purpose: "vehicle" });

    expect((await listApplications(owner)).some((row) => row.id === draft.id)).toBe(true);
    await expect(listApplications(other)).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id })]));
    await expect(getApplication(other, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(getApplication(quinn, draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(listApplications(quinn)).rejects.toMatchObject({ status: 403 });
    for (const call of [
      listApplications(admin),
      getApplication(admin, draft.id),
      updateApplication(admin, draft.id, { version: 1, purpose: "medical" }),
      deleteApplication(admin, draft.id),
      transitionApplication(admin, draft.id, { to: "withdrawn", version: 1 }),
      listNotes(admin, draft.id),
      addDocument(admin, draft.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF }),
    ]) {
      await expect(call).rejects.toMatchObject({ status: 404 });
    }

    const submitted = await createApplication(owner, complete);
    await addDocument(owner, submitted.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(owner, submitted.id, { kind: "pay_stub", displayName: "pay.png", bytes: DEMO_PNG });
    const sent = await transitionApplication(owner, submitted.id, { to: "submitted", version: submitted.version });
    expect(sent.status).toBe("submitted");
    await expect(getApplication(quinn, sent.id)).resolves.toMatchObject({ id: sent.id, status: "submitted" });
    await expect(updateApplication(quinn, sent.id, { version: sent.version, purpose: "medical" })).rejects.toMatchObject({ status: 403 });
  });

  it("walks every state-table row and rejects the illegal ones", async () => {
    const { createApplication, transitionApplication, updateApplication, deleteApplication } = await import("@/lib/applications");
    const { addDocument } = await import("@/lib/documents");
    const { listNotes } = await import("@/lib/notes");

    const applicant = await makeUser();
    const bare = await createApplication(applicant, { purpose: "medical" });
    await expect(transitionApplication(applicant, bare.id, { to: "submitted", version: bare.version })).rejects.toMatchObject({ status: 409 });
    const filled = await updateApplication(applicant, bare.id, { ...complete, version: bare.version });
    await expect(transitionApplication(applicant, filled.id, { to: "submitted", version: filled.version })).rejects.toMatchObject({ status: 409 });

    await addDocument(applicant, filled.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(applicant, filled.id, { kind: "bank_statement", displayName: "statement.pdf", bytes: Buffer.from(`${DEMO_PDF.toString("utf8")}\n`) });
    await expect(transitionApplication(quinn, filled.id, { to: "in_review", version: filled.version })).rejects.toMatchObject({ status: 404 });
    const sent = await transitionApplication(applicant, filled.id, { to: "submitted", version: filled.version });
    expect(sent.submittedAt).toBeTruthy();

    await expect(transitionApplication(applicant, sent.id, { to: "in_review", version: sent.version })).rejects.toMatchObject({ status: 403 });
    const claimed = await transitionApplication(quinn, sent.id, { to: "in_review", version: sent.version });
    expect(claimed.assignedUnderwriterId).toBe(quinn.id);
    await expect(transitionApplication(riley, claimed.id, { to: "approved", version: claimed.version })).rejects.toMatchObject({ status: 403 });
    await expect(transitionApplication(riley, claimed.id, { to: "submitted", version: claimed.version })).rejects.toMatchObject({ status: 403 });
    await expect(
      transitionApplication(riley, claimed.id, { to: "info_requested", version: claimed.version, message: "More docs" }),
    ).rejects.toMatchObject({ status: 403 });

    const released = await transitionApplication(quinn, claimed.id, { to: "submitted", version: claimed.version });
    expect(released.status).toBe("submitted");
    expect(released.assignedUnderwriterId).toBeNull();
    expect(await auditDetail(released.id, "application.released")).toMatchObject({ from: "in_review", to: "submitted" });

    const claimedAgain = await transitionApplication(quinn, released.id, { to: "in_review", version: released.version });
    await expect(
      transitionApplication(quinn, claimedAgain.id, { to: "info_requested", version: claimedAgain.version, message: " " }),
    ).rejects.toMatchObject({ status: 409 });
    const asked = await transitionApplication(quinn, claimedAgain.id, {
      to: "info_requested",
      version: claimedAgain.version,
      message: "Please add a pay stub.",
    });
    expect(asked.status).toBe("info_requested");
    const infoAudit = await auditDetail(asked.id, "application.info_requested");
    expect(infoAudit).not.toHaveProperty("message");
    expect(JSON.stringify(infoAudit)).not.toContain("pay stub");
    const notes = await listNotes(applicant, asked.id);
    expect(notes.some((note) => note.visibility === "applicant" && note.body.includes("pay stub"))).toBe(true);

    await expect(transitionApplication(applicant, asked.id, { to: "submitted", version: asked.version })).rejects.toMatchObject({ status: 409 });
    const replied = await transitionApplication(applicant, asked.id, {
      to: "submitted",
      version: asked.version,
      message: "The stub is the bank statement.",
    });
    expect(replied.status).toBe("submitted");
    expect(replied.assignedUnderwriterId).toBeNull();

    const review = await transitionApplication(quinn, replied.id, { to: "in_review", version: replied.version });
    await expect(
      transitionApplication(quinn, review.id, { to: "declined", version: review.version, codes: [] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitionApplication(quinn, review.id, { to: "declined", version: review.version, codes: ["OTHER"] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitionApplication(quinn, review.id, { to: "approved", version: review.version, codes: ["DTI_TOO_HIGH"] }),
    ).rejects.toMatchObject({ status: 409 });
    const declined = await transitionApplication(quinn, review.id, {
      to: "declined",
      version: review.version,
      codes: ["OTHER", "SHORT_EMPLOYMENT"],
      note: "Employment history is short.",
    });
    expect(declined.status).toBe("declined");
    expect(declined.decisionCodes).toEqual(["OTHER", "SHORT_EMPLOYMENT"]);
    const decided = await auditDetail(declined.id, "application.decided");
    expect(decided).toMatchObject({ to: "declined", codes: ["OTHER", "SHORT_EMPLOYMENT"] });
    expect(JSON.stringify(decided)).not.toContain("Employment history");
    await expect(transitionApplication(applicant, declined.id, { to: "withdrawn", version: declined.version })).rejects.toMatchObject({ status: 409 });
    await expect(deleteApplication(applicant, declined.id)).rejects.toMatchObject({ status: 409 });

    const withdrawer = await makeUser();
    const withdraw = await createApplication(withdrawer, complete);
    await addDocument(withdrawer, withdraw.id, { kind: "id", displayName: "id.png", bytes: DEMO_PNG });
    await addDocument(withdrawer, withdraw.id, { kind: "tax_return", displayName: "return.pdf", bytes: DEMO_PDF });
    const withdrawSent = await transitionApplication(withdrawer, withdraw.id, { to: "submitted", version: withdraw.version });
    await expect(transitionApplication(quinn, withdrawSent.id, { to: "withdrawn", version: withdrawSent.version })).rejects.toMatchObject({
      status: 403,
    });
    const withdrawn = await transitionApplication(withdrawer, withdrawSent.id, { to: "withdrawn", version: withdrawSent.version });
    expect(withdrawn.status).toBe("withdrawn");

    const approver = await makeUser();
    const approve = await createApplication(approver, complete);
    await addDocument(approver, approve.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(approver, approve.id, { kind: "pay_stub", displayName: "stub.png", bytes: DEMO_PNG });
    const approveSent = await transitionApplication(approver, approve.id, { to: "submitted", version: approve.version });
    const approveReview = await transitionApplication(riley, approveSent.id, { to: "in_review", version: approveSent.version });
    const approved = await transitionApplication(riley, approveReview.id, {
      to: "approved",
      version: approveReview.version,
      note: "File is complete.",
    });
    expect(approved.status).toBe("approved");
    expect(approved.decisionNote).toBe("File is complete.");
    expect(JSON.stringify(await auditDetail(approved.id, "application.decided"))).not.toContain("File is complete");
  });

  it("accepts a resubmit that adds a document instead of a message", async () => {
    const { createApplication, transitionApplication } = await import("@/lib/applications");
    const { addDocument } = await import("@/lib/documents");
    const owner = await makeUser();
    const row = await createApplication(owner, complete);
    await addDocument(owner, row.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(owner, row.id, { kind: "pay_stub", displayName: "stub.png", bytes: DEMO_PNG });
    const sent = await transitionApplication(owner, row.id, { to: "submitted", version: row.version });
    const review = await transitionApplication(quinn, sent.id, { to: "in_review", version: sent.version });
    const asked = await transitionApplication(quinn, review.id, {
      to: "info_requested",
      version: review.version,
      message: "One more statement.",
    });
    await addDocument(owner, asked.id, { kind: "bank_statement", displayName: "extra.pdf", bytes: Buffer.from(`${DEMO_PDF.toString("utf8")}\n`) });
    const back = await transitionApplication(owner, asked.id, { to: "submitted", version: asked.version });
    expect(back.status).toBe("submitted");
  });

  it("locks versions, caps open files at 3, and deletes drafts only", async () => {
    const { createApplication, updateApplication, deleteApplication } = await import("@/lib/applications");
    const owner = await makeUser();
    const first = await createApplication(owner, {});
    await expect(updateApplication(owner, first.id, { version: 99, purpose: "moving" })).rejects.toMatchObject({ status: 409 });
    const edited = await updateApplication(owner, first.id, { version: first.version, purpose: "moving" });
    expect(edited.purpose).toBe("moving");
    expect(edited.version).toBe(first.version + 1);
    expect(await auditDetail(edited.id, "application.updated")).toMatchObject({ fields: ["purpose"] });

    await createApplication(owner, {});
    await createApplication(owner, {});
    await expect(createApplication(owner, {})).rejects.toMatchObject({ status: 409 });

    await deleteApplication(owner, first.id);
    await expect(deleteApplication(ada, first.id)).rejects.toMatchObject({ status: 404 });
    const again = await createApplication(owner, complete);
    const { addDocument } = await import("@/lib/documents");
    const { transitionApplication } = await import("@/lib/applications");
    await addDocument(owner, again.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(owner, again.id, { kind: "pay_stub", displayName: "stub.png", bytes: DEMO_PNG });
    const sent = await transitionApplication(owner, again.id, { to: "submitted", version: again.version });
    await expect(deleteApplication(owner, sent.id)).rejects.toMatchObject({ status: 409 });
    const leftover = await sql<{ id: string }[]>`select id from application where applicant_id = ${owner.id} and status = 'draft' limit 1`;
    await deleteApplication(owner, leftover[0].id);
  });

  it("shows internal notes only to underwriters", async () => {
    const { createApplication, transitionApplication } = await import("@/lib/applications");
    const { addDocument } = await import("@/lib/documents");
    const { addNote, listNotes } = await import("@/lib/notes");
    const owner = await makeUser();
    const row = await createApplication(owner, complete);
    await addDocument(owner, row.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(owner, row.id, { kind: "tax_return", displayName: "return.pdf", bytes: Buffer.from(`${DEMO_PDF.toString("utf8")}\n% note\n`) });
    const sent = await transitionApplication(owner, row.id, { to: "submitted", version: row.version });
    const review = await transitionApplication(quinn, sent.id, { to: "in_review", version: sent.version });
    await expect(addNote(owner, review.id, { body: "secret", visibility: "internal" })).rejects.toMatchObject({ status: 403 });
    await addNote(owner, review.id, { body: "Here is the context.", visibility: "applicant" });
    await addNote(quinn, review.id, { body: "Internal only.", visibility: "internal" });
    const applicantNotes = await listNotes(owner, review.id);
    expect(applicantNotes.every((note) => note.visibility === "applicant")).toBe(true);
    expect((await listNotes(quinn, review.id)).map((note) => note.visibility).sort()).toEqual(["applicant", "internal"]);
    await expect(listNotes(ben, review.id)).rejects.toMatchObject({ status: 404 });
  });

  it("records an underwriter view at most once an hour", async () => {
    const { createApplication, getApplication, transitionApplication, listQueue } = await import("@/lib/applications");
    const { addDocument } = await import("@/lib/documents");
    const owner = await makeUser();
    const row = await createApplication(owner, complete);
    await addDocument(owner, row.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    await addDocument(owner, row.id, { kind: "pay_stub", displayName: "stub.png", bytes: DEMO_PNG });
    const sent = await transitionApplication(owner, row.id, { to: "submitted", version: row.version });
    await getApplication(quinn, sent.id);
    await getApplication(quinn, sent.id);
    const views = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
      where application_id = ${sent.id} and action = 'application.viewed' and actor_id = ${quinn.id}
    `;
    expect(views[0].n).toBe(1);
    const queue = await listQueue(quinn, "new");
    expect(queue.some((item) => item.id === sent.id)).toBe(true);
    await expect(listQueue(ada, "new")).rejects.toMatchObject({ status: 403 });
    await expect(listQueue(admin, "new")).rejects.toMatchObject({ status: 404 });
  });

  it("returns counts without application contents", async () => {
    const { adminStats } = await import("@/lib/admin-stats");
    await expect(adminStats(ada)).rejects.toMatchObject({ status: 403 });
    const stats = await adminStats(admin);
    expect(Object.keys(stats).sort()).toEqual([
      "applicationsByStatus",
      "documentCount",
      "documentsByKind",
      "storageCapBytes",
      "storageUsedBytes",
    ]);
    expect(JSON.stringify(stats)).not.toContain("ln-ada");
    expect(JSON.stringify(stats)).not.toContain("Northwind");
  });

  it("rejects audit updates, deletes, and truncates, and verify reports a hand edit", async () => {
    const { verifyAuditChain } = await import("@/lib/audit");
    await expect(sql`update audit_event set action = 'tampered' where id = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_event where id = 1`).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit_event`).rejects.toThrow(/append-only/);

    await expect(verifyAuditChain(ada)).rejects.toMatchObject({ status: 403 });
    expect(await verifyAuditChain(admin)).toMatchObject({ ok: true });

    await sql`alter table audit_event disable trigger audit_event_no_update_delete`;
    try {
      await sql`update audit_event set detail = '{"tampered":true}'::jsonb where id = 1`;
      const broken = await verifyAuditChain(admin);
      expect(broken).toMatchObject({ ok: false, id: 1 });
      if (!broken.ok) expect(broken.reason).toMatch(/hash/);
      await sql`update audit_event set detail = '{}'::jsonb where id = 1`;
    } finally {
      await sql`alter table audit_event enable trigger audit_event_no_update_delete`;
    }
    expect(await verifyAuditChain(admin)).toMatchObject({ ok: true });
  });

  it("keeps sign-up at user, refuses unknown roles, and audits a real role change", async () => {
    const { auth } = await import("@/lib/auth");
    const handler = auth().handler;
    const email = `ln-signup-${Date.now()}@test.local`;
    const signUp = await handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Signup", email, password: PASSWORD, role: "admin" }),
      }),
    );
    expect(signUp.status).toBe(200);
    const [signed] = await sql<{ id: string; role: string }[]>`select id, role from "user" where email = ${email}`;
    expect(signed.role).toBe("user");

    const adminEmail = `ln-role-admin-${Date.now()}@test.local`;
    const adminSign = await handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Role Admin", email: adminEmail, password: PASSWORD }),
      }),
    );
    expect(adminSign.status).toBe(200);
    const adminId = ((await adminSign.json()) as { user: { id: string } }).user.id;
    await sql`update "user" set role = 'admin' where id = ${adminId}`;
    const signIn = await handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");

    const call = (body: unknown, jar = cookie) =>
      handler(
        new Request("http://localhost:3000/api/auth/admin/set-role", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: jar },
          body: JSON.stringify(body),
        }),
      );

    expect((await call({ userId: signed.id, role: "superuser" })).status).toBe(400);
    expect((await call({ userId: signed.id, role: ["underwriter", "admin"] })).status).toBe(400);
    expect((await call({ userId: signed.id, role: "underwriter,admin" })).status).toBe(400);
    expect((await sql<{ role: string }[]>`select role from "user" where id = ${signed.id}`)[0].role).toBe("user");

    const granted = await call({ userId: signed.id, role: "underwriter" });
    expect(granted.status).toBe(200);
    expect((await sql<{ role: string }[]>`select role from "user" where id = ${signed.id}`)[0].role).toBe("underwriter");
    const [event] = await sql<{ detail: { userId: string; from: string; to: string }; actor_role: string }[]>`
      select detail, actor_role from audit_event where action = 'role.changed' and actor_id = ${adminId} order by id desc limit 1
    `;
    expect(event.actor_role).toBe("admin");
    expect(event.detail).toMatchObject({ userId: signed.id, from: "user", to: "underwriter" });

    const uwSign = await handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    const uwCookie = uwSign.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");
    expect((await call({ userId: adminId, role: "user" }, uwCookie)).status).toBe(403);
    expect((await sql<{ role: string }[]>`select role from "user" where id = ${adminId}`)[0].role).toBe("admin");
  });

  it("loads a demo workspace twice without adopting a foreign email", async () => {
    const { loadDemoWorkspace } = await import("@/lib/demo-workspace");
    await expect(
      loadDemoWorkspace({ actor: admin, actorEmail: "ada@demo.breakthru.test", password: "demo-password-1" }),
    ).rejects.toMatchObject({ status: 403 });

    await sql`insert into "user" (id, name, email, image) values ('ln-foreign', 'Foreign', 'ada@demo.breakthru.test', 'not-the-marker')`;
    await expect(loadDemoWorkspace({ actor: admin, password: "demo-password-1" })).rejects.toMatchObject({ status: 409 });
    await sql`delete from "user" where id = 'ln-foreign'`;

    await loadDemoWorkspace({ actor: admin, password: "demo-password-1" });
    await loadDemoWorkspace({ actor: admin, password: "demo-password-1" });
    const rows = await sql<{ status: string; n: number }[]>`
      select a.status, count(*)::int as n
      from application a
      join "user" u on u.id = a.applicant_id
      where u.email in ('ada@demo.breakthru.test', 'ben@demo.breakthru.test')
      group by a.status
    `;
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.n]));
    expect(counts).toMatchObject({ draft: 1, submitted: 1, in_review: 1 });
    const [quinn] = await sql<{ role: string; image: string }[]>`
      select role, image from "user" where email = 'quinn@demo.breakthru.test'
    `;
    expect(quinn).toMatchObject({ role: "underwriter" });
  });
});
