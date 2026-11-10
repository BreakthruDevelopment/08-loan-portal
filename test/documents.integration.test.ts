/**
 * The document vault against Postgres: upload and download routes (called directly, with the session mocked),
 * every access rule, every cap including under concurrency, and the audit rows. Skips when TEST_DATABASE_URL is unset.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/rbac";
import { DEMO_PDF, DEMO_PNG } from "@/lib/demo-files";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const MB = 1024 * 1024;

let current: Actor | null = null;
vi.mock("@/lib/auth/session", async () => {
  const { UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireUser: async () => {
      if (!current) throw new UnauthorizedError();
      return current;
    },
  };
});

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

/** A valid-looking PNG of `size` bytes, unique per `n` (so the content hash differs). */
function png(size: number, n: number): Buffer {
  const out = Buffer.alloc(Math.max(Math.floor(size), 16));
  DEMO_PNG.copy(out, 0, 0, 8);
  out.writeUInt32BE(n, 8);
  return out;
}

describe.skipIf(!url)("document vault (Postgres)", () => {
  let sql: postgres.Sql;
  const quinn = { id: "dv-quinn", role: "underwriter" as const };
  const admin = { id: "dv-admin", role: "admin" as const };
  let seq = 0;

  async function makeUser(role: "user" | "underwriter" | "admin" = "user") {
    seq += 1;
    const id = `dv-x${seq}`;
    await sql`insert into "user" (id, name, email, role) values (${id}, ${id}, ${`${id}@test.local`}, ${role})`;
    return { id, role } as Actor;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = ORIGIN;
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await sql`delete from application where applicant_id like 'dv-%'`;
    await sql`delete from "user" where id like 'dv-%'`;
    for (const person of [quinn, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${person.id}, ${person.id}, ${person.id + "@test.local"}, ${person.role})`;
    }
  });

  afterEach(async () => {
    current = null;
    delete process.env.DOC_STORAGE_CAP_MB;
    delete process.env.UPLOAD_READ_TIMEOUT_MS;
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
  });

  afterAll(async () => {
    await sql`delete from application where applicant_id like 'dv-%'`;
    await sql`delete from "user" where id like 'dv-%'`;
    await sql.end();
  });

  // ---- helpers -----------------------------------------------------------------------------------------------

  async function uploadRequest(
    applicationId: string,
    opts: { name?: string; bytes: Uint8Array; kind?: string; origin?: string | null; length?: string | null },
  ) {
    const form = new FormData();
    form.set("kind", opts.kind ?? "id");
    form.set("file", new File([opts.bytes as BlobPart], opts.name ?? "id.png"));
    const probe = new Response(form);
    const headers = new Headers({ "content-type": probe.headers.get("content-type")! });
    const body = Buffer.from(await probe.arrayBuffer());
    if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
    if (opts.length !== null) headers.set("content-length", opts.length ?? String(body.length));
    return new Request(`${ORIGIN}/api/applications/${applicationId}/documents`, { method: "POST", headers, body });
  }

  async function upload(actor: Actor | null, applicationId: string, opts: Parameters<typeof uploadRequest>[1]) {
    const { POST } = await import("@/app/api/applications/[id]/documents/route");
    const request = await uploadRequest(applicationId, opts);
    // The mocked session is read synchronously when the handler starts, so set it right before the call.
    current = actor;
    return POST(request, { params: Promise.resolve({ id: applicationId }) });
  }

  /** The data layer directly (no HTTP), for caps under concurrency: the route admits one upload per user at a time. */
  async function addStatus(actor: Actor, applicationId: string, bytes: Uint8Array, kind = "id" as const, name = "id.png") {
    const { addDocument } = await import("@/lib/documents");
    try {
      await addDocument(actor, applicationId, { kind, displayName: name, bytes });
      return 201;
    } catch (err) {
      return (err as { status?: number }).status ?? 500;
    }
  }

  async function download(actor: Actor | null, documentId: string, query = "") {
    const { GET } = await import("@/app/api/documents/[id]/route");
    current = actor;
    return GET(new Request(`${ORIGIN}/api/documents/${documentId}${query}`), { params: Promise.resolve({ id: documentId }) });
  }

  async function remove(actor: Actor | null, documentId: string, origin: string | null = ORIGIN) {
    const { DELETE } = await import("@/app/api/documents/[id]/route");
    current = actor;
    const headers = new Headers();
    if (origin) headers.set("origin", origin);
    return DELETE(new Request(`${ORIGIN}/api/documents/${documentId}`, { method: "DELETE", headers }), {
      params: Promise.resolve({ id: documentId }),
    });
  }

  async function draft(owner: Actor, fields: object = {}) {
    const { createApplication } = await import("@/lib/applications");
    return createApplication(owner, fields);
  }

  async function addTwo(owner: Actor, applicationId: string) {
    const { addDocument } = await import("@/lib/documents");
    const id = await addDocument(owner, applicationId, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
    const pay = await addDocument(owner, applicationId, { kind: "pay_stub", displayName: "pay.png", bytes: DEMO_PNG });
    return { id, pay };
  }

  async function submit(owner: Actor) {
    const { transitionApplication } = await import("@/lib/applications");
    const created = await draft(owner, complete);
    const docs = await addTwo(owner, created.id);
    const sent = await transitionApplication(owner, created.id, { to: "submitted", version: created.version });
    return { application: sent, docs };
  }

  async function audit(applicationId: string, action: string) {
    return sql<{ actor_id: string; actor_role: string; document_id: string | null; detail: Record<string, unknown> }[]>`
      select actor_id, actor_role, document_id, detail from audit_event
      where application_id = ${applicationId} and action = ${action} order by id`;
  }

  // ---- upload: refused before reading -----------------------------------------------------------------------------

  it("refuses a missing Content-Length (411) and 6 MB (413) before reading the body", async () => {
    const { POST } = await import("@/app/api/applications/[id]/documents/route");
    const owner = await makeUser();
    const app = await draft(owner);
    current = owner;
    const boundary = "----vault";
    const stream = (): { body: ReadableStream<Uint8Array>; pulled: () => boolean } => {
      let pulled = false;
      return {
        pulled: () => pulled,
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulled = true;
              controller.enqueue(new Uint8Array(1024));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      };
    };
    const make = (lengthHeader: string | null, s: { body: ReadableStream<Uint8Array> }) => {
      const headers = new Headers({ "content-type": `multipart/form-data; boundary=${boundary}`, origin: ORIGIN });
      if (lengthHeader !== null) headers.set("content-length", lengthHeader);
      return new Request(`${ORIGIN}/x`, { method: "POST", headers, body: s.body, duplex: "half" } as RequestInit);
    };

    const missing = stream();
    const res411 = await POST(make(null, missing), { params: Promise.resolve({ id: app.id }) });
    expect(res411.status).toBe(411);
    expect(missing.pulled()).toBe(false);

    const big = stream();
    const res413 = await POST(make(String(6 * MB), big), { params: Promise.resolve({ id: app.id }) });
    expect(res413.status).toBe(413);
    expect(big.pulled()).toBe(false);

    const junk = stream();
    expect((await POST(make("abc", junk), { params: Promise.resolve({ id: app.id }) })).status).toBe(400);
    expect(junk.pulled()).toBe(false);
  });

  it("caps the bytes while streaming when Content-Length lies", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const res = await upload(owner, app.id, { bytes: png(6 * MB, 1), length: "100" });
    expect(res.status).toBe(413);
    const [{ n }] = await sql`select count(*)::int as n from document where application_id = ${app.id}`;
    expect(n).toBe(0);
  });

  it("refuses a file just over 5 MB that fits the body limit, and accepts exactly 5 MB", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    expect((await upload(owner, app.id, { bytes: png(5 * MB + 1, 1) })).status).toBe(413);
    expect((await upload(owner, app.id, { bytes: png(5 * MB, 2) })).status).toBe(201);
  });

  it("requires a session and our own origin", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    expect((await upload(null, app.id, { bytes: DEMO_PNG })).status).toBe(401);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG, origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG, origin: null })).status).toBe(403);
    expect((await remove(null, "00000000-0000-4000-8000-000000000000")).status).toBe(401);
    expect((await remove(owner, "00000000-0000-4000-8000-000000000000", "https://evil.example")).status).toBe(403);
  });

  // ---- upload: content rules ------------------------------------------------------------------------------------

  it("sniffs by content: HTML as .pdf, a PNG labelled JPEG, no extension, and SVG are refused (415)", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await upload(owner, app.id, { name: "id.pdf", bytes: html })).status).toBe(415);
    expect((await upload(owner, app.id, { name: "id.jpg", bytes: DEMO_PNG })).status).toBe(415);
    expect((await upload(owner, app.id, { name: "id", bytes: DEMO_PNG })).status).toBe(415);
    expect((await upload(owner, app.id, { name: "id.png", bytes: DEMO_PDF })).status).toBe(415);
    expect((await upload(owner, app.id, { name: "logo.svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") })).status).toBe(415);
    const [{ n }] = await sql`select count(*)::int as n from document where application_id = ${app.id}`;
    expect(n).toBe(0);
  });

  it("refuses PDFs with scripts, attachments, launch actions or passwords (422), also when called directly", async () => {
    const { addDocument } = await import("@/lib/documents");
    const owner = await makeUser();
    const app = await draft(owner);
    const bad = [
      "1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj",
      "1 0 obj<</S/Launch>>endobj",
      "1 0 obj<</Type/EmbeddedFile>>endobj",
      "1 0 obj<</Subtype/RichMedia>>endobj",
      "1 0 obj<</XFA[]>>endobj",
      "trailer<</Encrypt 5 0 R>>",
      "1 0 obj<</S/Java#53cript>>endobj",
    ].map((body) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1"));
    for (const bytes of bad) {
      expect((await upload(owner, app.id, { name: "id.pdf", bytes })).status).toBe(422);
      await expect(addDocument(owner, app.id, { kind: "id", displayName: "id.pdf", bytes })).rejects.toMatchObject({ status: 422 });
    }
    const res = await upload(owner, app.id, { name: "id.pdf", bytes: bad[0] });
    expect((await res.json()).error).toBe("PDFs with scripts, attachments or passwords aren't accepted.");
    const [{ n }] = await sql`select count(*)::int as n from document where application_id = ${app.id}`;
    expect(n).toBe(0);
  });

  it("stores the sniffed type, a sanitised name, and audits with ids and codes only", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const res = await upload(owner, app.id, { name: "../..\\My Secret Pay‮.PNG", bytes: DEMO_PNG, kind: "pay_stub" });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toMatchObject({ kind: "pay_stub", contentType: "image/png", sizeBytes: DEMO_PNG.length });
    expect(document.displayName).not.toMatch(/[\\/‮]/);
    expect(document.sha256).toBeUndefined();
    expect(document.applicantId).toBeUndefined();
    const rows = await audit(app.id, "document.uploaded");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: owner.id, actor_role: "user", document_id: document.id });
    expect(rows[0].detail).toEqual({ kind: "pay_stub", contentType: "image/png", sizeBytes: DEMO_PNG.length });
    expect(JSON.stringify(rows[0].detail)).not.toMatch(/Secret|\.png/i);
  });

  it("rejects an unknown kind, two files, and no file (400); the same file twice is 409", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG, kind: "selfie" })).status).toBe(400);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG })).status).toBe(201);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG })).status).toBe(409);
    const { POST } = await import("@/app/api/applications/[id]/documents/route");
    current = owner;
    const form = new FormData();
    form.set("kind", "id");
    form.append("file", new File([png(64, 7) as BlobPart], "a.png"));
    form.append("file", new File([png(64, 8) as BlobPart], "b.png"));
    const probe = new Response(form);
    const body = Buffer.from(await probe.arrayBuffer());
    const two = await POST(
      new Request(`${ORIGIN}/x`, {
        method: "POST",
        headers: { "content-type": probe.headers.get("content-type")!, "content-length": String(body.length), origin: ORIGIN },
        body,
      }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(two.status).toBe(400);
    const none = new FormData();
    none.set("kind", "id");
    const probe2 = new Response(none);
    const body2 = Buffer.from(await probe2.arrayBuffer());
    const noFile = await POST(
      new Request(`${ORIGIN}/x`, {
        method: "POST",
        headers: { "content-type": probe2.headers.get("content-type")!, "content-length": String(body2.length), origin: ORIGIN },
        body: body2,
      }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(noFile.status).toBe(400);
  });

  it("allows a re-upload after the duplicate was deleted", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const first = await (await upload(owner, app.id, { bytes: DEMO_PNG })).json();
    expect((await remove(owner, first.document.id)).status).toBe(204);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG })).status).toBe(201);
  });

  // ---- who may upload ----------------------------------------------------------------------------------------------

  it("lets only the owner upload: another applicant 404, underwriter 403, admin 404", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const app = await draft(owner);
    expect((await upload(other, app.id, { bytes: DEMO_PNG })).status).toBe(404);
    expect((await upload(quinn, app.id, { bytes: DEMO_PNG })).status).toBe(403);
    expect((await upload(admin, app.id, { bytes: DEMO_PNG })).status).toBe(404);
    expect((await upload(owner, app.id, { bytes: DEMO_PNG })).status).toBe(201);
    expect((await upload(owner, "not-a-uuid", { bytes: DEMO_PNG })).status).toBe(404);
  });

  it("locks uploads after submit, allows them while info is requested, and locks them again after a decision", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const owner = await makeUser();
    const { application } = await submit(owner);
    expect((await upload(owner, application.id, { bytes: png(64, 50) })).status).toBe(409);

    const claimed = await transitionApplication(quinn, application.id, { to: "in_review", version: application.version });
    expect((await upload(owner, application.id, { bytes: png(64, 51) })).status).toBe(409);
    const asked = await transitionApplication(quinn, application.id, {
      to: "info_requested",
      version: claimed.version,
      message: "Please add a bank statement.",
    });
    expect((await upload(owner, application.id, { bytes: png(64, 52), kind: "bank_statement" })).status).toBe(201);

    const resent = await transitionApplication(owner, application.id, { to: "submitted", version: asked.version });
    expect((await upload(owner, application.id, { bytes: png(64, 53) })).status).toBe(409);
    const claimedAgain = await transitionApplication(quinn, application.id, { to: "in_review", version: resent.version });
    await transitionApplication(quinn, application.id, { to: "approved", version: claimedAgain.version });
    expect((await upload(owner, application.id, { bytes: png(64, 54) })).status).toBe(409);
  });

  // ---- caps ----------------------------------------------------------------------------------------------------------

  it("allows 8 files per application, also under concurrency", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const statuses = (await Promise.all(Array.from({ length: 14 }, (_, i) => addStatus(owner, app.id, png(2048, 100 + i))))).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(8);
    expect(statuses.filter((s) => s === 409)).toHaveLength(6);
    const [{ n }] = await sql`select count(*)::int as n from document where application_id = ${app.id} and deleted_at is null`;
    expect(n).toBe(8);
    const [{ blobs }] = await sql`select count(*)::int as blobs from document_blob where document_id in (select id from document where application_id = ${app.id})`;
    expect(blobs).toBe(8);
  });

  it("allows 20 MB per application, also under concurrency", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => addStatus(owner, app.id, png(4.9 * MB, 200 + i))));
    expect(results.filter((r) => r === 201)).toHaveLength(4);
    expect(results.filter((r) => r === 409)).toHaveLength(3);
    const [{ total }] = await sql`select coalesce(sum(size_bytes), 0)::bigint as total from document where application_id = ${app.id}`;
    expect(Number(total)).toBeLessThanOrEqual(20 * MB);
  });

  it("rate-limits uploads per applicant: 30 an hour, then 429", async () => {
    const owner = await makeUser();
    const apps = await Promise.all([draft(owner), draft(owner), draft(owner)]);
    let n = 300;
    const sent: number[] = [];
    // Each accepted file is deleted again, so the per-application caps never get in the way.
    for (let i = 0; i < 36; i += 1) {
      const res = await upload(owner, apps[i % 3].id, { bytes: png(64, (n += 1)) });
      sent.push(res.status);
      if (res.status === 201) await remove(owner, (await res.json()).document.id);
    }
    expect(sent.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(sent.slice(30).every((s) => s === 429)).toBe(true);
    expect(sent.length).toBe(36);
  });

  it("fails closed at the app-wide cap, also under concurrency, and exactly one upload fits the last gap", async () => {
    const [{ total }] = await sql`select coalesce(sum(size_bytes), 0)::bigint as total from document where deleted_at is null`;
    const used = Number(total);
    const capMb = Math.ceil(used / MB) + 1;
    const room = capMb * MB - used; // between 1 MB and 2 MB
    const size = Math.floor(room * 0.6); // one fits, two don't
    process.env.DOC_STORAGE_CAP_MB = String(capMb);
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();

    const owners = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const apps = await Promise.all(owners.map((o) => draft(o)));
    const results = await Promise.all(apps.map((a, i) => addStatus(owners[i], a.id, png(size, 300 + i))));
    expect([...results].sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const { addDocument } = await import("@/lib/documents");
    await expect(addDocument(owners[0], apps[0].id, { kind: "other", displayName: "x.png", bytes: png(size, 399) })).rejects.toThrow(/storage is full/i);
    const [after] = await sql`select coalesce(sum(size_bytes), 0)::bigint as total from document where deleted_at is null`;
    expect(Number(after.total)).toBeLessThanOrEqual(capMb * MB);

    // Over the cap already (a filler row counted by size): every upload is refused.
    const filler = await draft(owners[0]);
    await sql`insert into document (application_id, applicant_id, kind, display_name, content_type, size_bytes, sha256)
      values (${filler.id}, ${owners[0].id}, 'other', 'filler.pdf', 'application/pdf', ${5 * MB}, ${"f".repeat(64)})`;
    process.env.DOC_STORAGE_CAP_MB = "1";
    resetEnvCache();
    const fresh = await makeUser();
    const freshApp = await draft(fresh);
    expect((await upload(fresh, freshApp.id, { bytes: png(64, 400) })).status).toBe(409);
    await sql`delete from document where id = (select id from document where application_id = ${filler.id})`;
  });

  it("frees storage when a document is deleted: its bytes go at once", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const { document } = await (await upload(owner, app.id, { bytes: png(1024, 500) })).json();
    expect((await sql`select 1 from document_blob where document_id = ${document.id}`).length).toBe(1);
    expect((await remove(owner, document.id)).status).toBe(204);
    expect((await sql`select 1 from document_blob where document_id = ${document.id}`).length).toBe(0);
    const [row] = await sql`select deleted_at from document where id = ${document.id}`;
    expect(row.deleted_at).not.toBeNull();
  });

  it("serialises uploads against submit: an upload that lands is part of the submission, never after it", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    let uploadedAfterSubmit = 0;
    const outcomes = new Set<number>();
    for (let round = 0; round < 8; round += 1) {
      const owner = await makeUser();
      const created = await draft(owner, complete);
      await addTwo(owner, created.id);
      const [sent, extra] = await Promise.all([
        transitionApplication(owner, created.id, { to: "submitted", version: created.version }),
        upload(owner, created.id, { bytes: png(64, 600 + round), kind: "other" }),
      ]);
      expect(sent.status).toBe("submitted");
      outcomes.add(extra.status);
      expect([201, 409]).toContain(extra.status);
      const uploaded = await audit(created.id, "document.uploaded");
      const submittedRows = await sql<{ id: number }[]>`select id from audit_event where application_id = ${created.id} and action = 'application.submitted'`;
      const lateUploads = await sql`select 1 from audit_event where application_id = ${created.id} and action = 'document.uploaded' and id > ${submittedRows[0].id}`;
      uploadedAfterSubmit += lateUploads.length;
      expect(uploaded.length).toBe(2 + (extra.status === 201 ? 1 : 0));
    }
    expect(uploadedAfterSubmit).toBe(0);
  });

  // ---- download ----------------------------------------------------------------------------------------------------

  it("sends the exact download headers and never an upload-derived name", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const pdf = await (await upload(owner, app.id, { name: "<img src=x onerror=1>.pdf", bytes: DEMO_PDF })).json();
    const image = await (await upload(owner, app.id, { name: "photo.png", bytes: DEMO_PNG, kind: "pay_stub" })).json();

    const res = await download(owner, pdf.document.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(DEMO_PDF)).toBe(true);
    expect(Object.fromEntries(res.headers.entries())).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="document-${pdf.document.id}.pdf"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
      "content-length": String(DEMO_PDF.length),
    });

    const asPdfInline = await download(owner, pdf.document.id, "?inline=1");
    expect(asPdfInline.headers.get("content-disposition")).toBe(`attachment; filename="document-${pdf.document.id}.pdf"`);

    const preview = await download(owner, image.document.id, "?inline=1");
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("content-disposition")).toBe(`inline; filename="document-${image.document.id}.png"`);
    expect(preview.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");

    const plainImage = await download(owner, image.document.id);
    expect(plainImage.headers.get("content-disposition")).toBe(`attachment; filename="document-${image.document.id}.png"`);

    expect((await download(owner, image.document.id, "?inline=yes")).status).toBe(400);
    expect((await download(owner, image.document.id, "?other=1")).status).toBe(400);
    expect((await download(owner, "not-a-uuid")).status).toBe(404);
    expect((await download(null, image.document.id)).status).toBe(401);
  });

  it("never serves HTML or SVG: the stored type is a sniffed PDF, PNG, or JPEG", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
    const res = await upload(owner, app.id, { name: "scan.jpeg", bytes: jpeg });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    const got = await download(owner, document.id);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="document-${document.id}.jpg"`);
    const types = await sql`select distinct content_type from document where applicant_id like 'dv-%'`;
    for (const row of types) expect(["application/pdf", "image/png", "image/jpeg"]).toContain(row.content_type);
  });

  it("shows a document to its owner only; another applicant and admin get 404", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { application, docs } = await submit(owner);
    expect((await download(owner, docs.id.id)).status).toBe(200);
    expect((await download(other, docs.id.id)).status).toBe(404);
    expect((await download(admin, docs.id.id)).status).toBe(404);
    expect((await download(admin, docs.id.id, "?inline=1")).status).toBe(404);
    const { listDocuments } = await import("@/lib/documents");
    await expect(listDocuments(other, application.id)).rejects.toMatchObject({ status: 404 });
    await expect(listDocuments(admin, application.id)).rejects.toMatchObject({ status: 404 });
    // An unknown id looks the same as someone else's.
    expect((await download(other, "11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });

  it("hides a draft's documents from an underwriter, then shows them after submit", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const { listDocuments } = await import("@/lib/documents");
    const owner = await makeUser();
    const created = await draft(owner, complete);
    const docs = await addTwo(owner, created.id);
    expect((await download(quinn, docs.id.id)).status).toBe(404);
    await expect(listDocuments(quinn, created.id)).rejects.toMatchObject({ status: 404 });
    await transitionApplication(owner, created.id, { to: "submitted", version: created.version });
    expect((await download(quinn, docs.id.id)).status).toBe(200);
    expect((await download(quinn, docs.pay.id, "?inline=1")).status).toBe(200);
    await expect(listDocuments(quinn, created.id)).resolves.toHaveLength(2);
  });

  it("keeps a withdrawn draft's documents from underwriters (never submitted)", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const owner = await makeUser();
    const created = await draft(owner, complete);
    const docs = await addTwo(owner, created.id);
    await transitionApplication(owner, created.id, { to: "withdrawn", version: created.version });
    expect((await download(quinn, docs.id.id)).status).toBe(404);
    expect((await download(owner, docs.id.id)).status).toBe(200);
  });

  it("audits every upload, download, preview and delete with ids and codes only", async () => {
    const owner = await makeUser();
    const { application, docs } = await submit(owner);
    await download(quinn, docs.id.id);
    await download(quinn, docs.pay.id, "?inline=1");
    await download(owner, docs.id.id);
    const downloads = await audit(application.id, "document.downloaded");
    expect(downloads.map((r) => [r.actor_role, r.document_id, r.detail])).toEqual([
      ["underwriter", docs.id.id, { kind: "id", contentType: "application/pdf", inline: false }],
      ["underwriter", docs.pay.id, { kind: "pay_stub", contentType: "image/png", inline: true }],
      ["user", docs.id.id, { kind: "id", contentType: "application/pdf", inline: false }],
    ]);
    expect(downloads[0].actor_id).toBe(quinn.id);

    // A refused download writes nothing.
    const stranger = await makeUser();
    await download(stranger, docs.id.id);
    await download(admin, docs.id.id);
    expect(await audit(application.id, "document.downloaded")).toHaveLength(3);

    const draftApp = await draft(owner);
    const up = await (await upload(owner, draftApp.id, { name: "private-name.png", bytes: png(64, 700) })).json();
    await remove(owner, up.document.id);
    const deleted = await audit(draftApp.id, "document.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].detail).toEqual({ kind: "id" });
    const all = await sql`select detail::text as d from audit_event where application_id in (${application.id}, ${draftApp.id})`;
    for (const row of all) expect(row.d).not.toMatch(/private-name|id\.pdf|pay\.png/);

    const { verifyAuditChain } = await import("@/lib/audit");
    await expect(verifyAuditChain(admin)).resolves.toMatchObject({ ok: true });
  });

  it("writes the upload and its audit row in one transaction: no audit row, no document", async () => {
    const { addDocument } = await import("@/lib/documents");
    const owner = await makeUser();
    const app = await draft(owner);
    // Fail the audit insert on the document-id uniqueness is not possible, so make the audit append throw instead.
    const audit_ = await import("@/lib/audit");
    const spy = vi.spyOn(audit_, "appendAudit").mockRejectedValueOnce(new Error("boom"));
    await expect(addDocument(owner, app.id, { kind: "id", displayName: "id.png", bytes: DEMO_PNG })).rejects.toThrow("boom");
    spy.mockRestore();
    const [{ docs, blobs }] = await sql`select (select count(*)::int from document where application_id = ${app.id}) as docs,
      (select count(*)::int from document_blob b join document d on d.id = b.document_id where d.application_id = ${app.id}) as blobs`;
    expect([docs, blobs]).toEqual([0, 0]);
  });

  // ---- delete ----------------------------------------------------------------------------------------------------------

  it("lets only the owner delete, only while editable; a deleted file is gone for everyone", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const created = await draft(owner);
    const { document } = await (await upload(owner, created.id, { bytes: DEMO_PNG })).json();
    expect((await remove(other, document.id)).status).toBe(404);
    expect((await remove(admin, document.id)).status).toBe(404);
    expect((await remove(quinn, document.id)).status).toBe(403);
    expect((await remove(owner, document.id)).status).toBe(204);
    expect((await remove(owner, document.id)).status).toBe(404);
    expect((await download(owner, document.id)).status).toBe(404);
    const { listDocuments } = await import("@/lib/documents");
    await expect(listDocuments(owner, created.id)).resolves.toHaveLength(0);
  });

  it("refuses deletes once submitted, and in info_requested only for files added since the request", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const owner = await makeUser();
    const { application, docs } = await submit(owner);
    expect((await remove(owner, docs.id.id)).status).toBe(409);
    const claimed = await transitionApplication(quinn, application.id, { to: "in_review", version: application.version });
    expect((await remove(owner, docs.id.id)).status).toBe(409);
    await transitionApplication(quinn, application.id, { to: "info_requested", version: claimed.version, message: "One more, please." });
    // The file the underwriter may already have read stays; a new one can be taken back.
    expect((await remove(owner, docs.pay.id)).status).toBe(409);
    const extra = await (await upload(owner, application.id, { bytes: png(64, 800), kind: "bank_statement" })).json();
    expect((await remove(owner, extra.document.id)).status).toBe(204);
    expect((await download(quinn, docs.pay.id)).status).toBe(200);
  });

  it("keeps the submit rule: a draft can't be submitted without an id and an income document, nor after deleting one", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const owner = await makeUser();
    const created = await draft(owner, complete);
    await expect(transitionApplication(owner, created.id, { to: "submitted", version: created.version })).rejects.toMatchObject({ status: 409 });
    const { id, pay } = await addTwo(owner, created.id);
    await remove(owner, pay.id);
    await expect(transitionApplication(owner, created.id, { to: "submitted", version: created.version })).rejects.toMatchObject({ status: 409 });
    expect((await upload(owner, created.id, { bytes: png(64, 900), kind: "tax_return" })).status).toBe(201);
    expect(id.id).toBeTruthy();
    await expect(transitionApplication(owner, created.id, { to: "submitted", version: created.version })).resolves.toMatchObject({ status: "submitted" });
  });

  // ---- list queries never select bytes ----------------------------------------------------------------------------

  it("returns metadata only from list queries", async () => {
    const { listDocuments } = await import("@/lib/documents");
    const owner = await makeUser();
    const created = await draft(owner);
    await addTwo(owner, created.id);
    const rows = await listDocuments(owner, created.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["applicationId", "contentType", "deletable", "displayName", "id", "kind", "sizeBytes", "uploadedAt"]);
    }
    const { GET } = await import("@/app/api/applications/[id]/documents/route");
    current = owner;
    const res = await GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: created.id }) });
    const text = await res.text();
    expect(text).not.toMatch(/"bytes"|sha256|applicantId/);
  });

  it("selects document_blob in one place only (getDocumentContent)", () => {
    const root = path.resolve(__dirname, "../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && /documentBlob|document_blob/.test(readFileSync(full, "utf8"))) {
          hits.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(["lib/db/schema.ts", "lib/documents.ts"]);
    const source = readFileSync(path.join(root, "lib/documents.ts"), "utf8");
    expect(source.match(/documentBlob\.bytes/g)).toHaveLength(1);
    expect(source.match(/\.select\([^)]*\)\s*\.from\(schema\.documentBlob\)/g)).toHaveLength(1);
  });

  it("refuses a blob the database shouldn't hold: empty or over 5 MB", async () => {
    const owner = await makeUser();
    const created = await draft(owner);
    const { document } = await (await upload(owner, created.id, { bytes: DEMO_PNG })).json();
    await expect(sql`update document_blob set bytes = ''::bytea where document_id = ${document.id}`).rejects.toThrow();
    await expect(sql`update document_blob set bytes = ${Buffer.alloc(5 * MB + 1)} where document_id = ${document.id}`).rejects.toThrow();
  });
  // ---- in-flight caps, charging before the read, timeout ---------------------------------------------------------

  /** A real upload whose body doesn't start flowing until `open()`; `pulled()` says whether anything read it. */
  async function gatedUpload(actor: Actor, applicationId: string, opts: { bytes: Uint8Array; stall?: boolean } & Record<string, unknown>) {
    const { POST } = await import("@/app/api/applications/[id]/documents/route");
    const source = await uploadRequest(applicationId, { bytes: opts.bytes });
    const payload = Buffer.from(await source.clone().arrayBuffer());
    let pulled = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulled = true;
          if (opts.stall) await new Promise(() => undefined); // never sends anything
          await gate;
          controller.enqueue(new Uint8Array(payload));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(source.url, { method: "POST", headers: source.headers, body, duplex: "half" } as RequestInit);
    current = actor;
    const response = POST(request, { params: Promise.resolve({ id: applicationId }) });
    return { response, open, pulled: () => pulled };
  }

  async function waitForSlots(n: number) {
    const { uploadSlotsInUse } = await import("@/lib/upload-slots");
    for (let i = 0; i < 200 && uploadSlotsInUse() !== n; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(uploadSlotsInUse()).toBe(n);
  }

  it("lets one user have one upload in flight: the rest are 429 with Retry-After, before any body is read", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const holder = await gatedUpload(owner, app.id, { bytes: png(64, 1000) });
    await waitForSlots(1);

    const extras = await Promise.all(Array.from({ length: 8 }, (_, i) => gatedUpload(owner, app.id, { bytes: png(64, 1001 + i) })));
    const answers = await Promise.all(extras.map((e) => e.response));
    expect(answers.map((r) => r.status)).toEqual(Array(8).fill(429));
    expect(answers.every((r) => r.headers.get("retry-after") !== null)).toBe(true);
    expect(extras.some((e) => e.pulled())).toBe(false);
    // The admitted upload is the only one that gets as far as reading.
    for (let i = 0; i < 200 && !holder.pulled(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(holder.pulled()).toBe(true);

    holder.open();
    expect((await holder.response).status).toBe(201);
    await waitForSlots(0);
    // Refused-by-slot attempts weren't charged: only the one real upload was.
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${owner.id} and kind = 'upload'`;
    expect(n).toBe(1);
    expect((await upload(owner, app.id, { bytes: png(64, 1100) })).status).toBe(201);
  });

  it("lets two uploads run per process: a third user gets 503 with Retry-After before any body is read", async () => {
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const [appA, appB, appC] = await Promise.all([draft(a), draft(b), draft(c)]);
    const first = await gatedUpload(a, appA.id, { bytes: png(64, 1200) });
    const second = await gatedUpload(b, appB.id, { bytes: png(64, 1201) });
    await waitForSlots(2);

    const refused = await Promise.all(Array.from({ length: 5 }, (_, i) => gatedUpload(c, appC.id, { bytes: png(64, 1210 + i) })));
    const answers = await Promise.all(refused.map((r) => r.response));
    // Several from the same user hit the per-process cap or, once one is admitted, the per-user cap; none is admitted here.
    expect(answers.map((r) => r.status)).toEqual(Array(5).fill(503));
    expect(answers.every((r) => r.headers.get("retry-after") !== null)).toBe(true);
    expect(refused.some((r) => r.pulled())).toBe(false);

    first.open();
    second.open();
    expect((await first.response).status).toBe(201);
    expect((await second.response).status).toBe(201);
    await waitForSlots(0);
    expect((await upload(c, appC.id, { bytes: png(64, 1220) })).status).toBe(201);
  });

  it("releases the slot when an upload fails", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    expect((await upload(owner, app.id, { name: "x.pdf", bytes: Buffer.from("<html>") })).status).toBe(415);
    await waitForSlots(0);
    expect((await upload(owner, "00000000-0000-4000-8000-000000000000", { bytes: png(64, 1300) })).status).toBe(404);
    await waitForSlots(0);
  });

  it("charges the hourly limit before reading: failed attempts count, a success is charged once", async () => {
    const owner = await makeUser();
    const app = await draft(owner);
    const html = Buffer.from("<html></html>");
    for (let i = 0; i < 30; i += 1) expect((await upload(owner, app.id, { name: "id.pdf", bytes: html })).status).toBe(415);
    const held = await gatedUpload(owner, app.id, { bytes: png(64, 1400) });
    const res = await held.response;
    expect(res.status).toBe(429);
    expect(held.pulled()).toBe(false);
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${owner.id} and kind = 'upload'`;
    expect(n).toBe(30);

    const fresh = await makeUser();
    const freshApp = await draft(fresh);
    expect((await upload(fresh, freshApp.id, { bytes: png(64, 1401) })).status).toBe(201);
    const [{ one }] = await sql`select count(*)::int as one from rate_event where user_id = ${fresh.id} and kind = 'upload'`;
    expect(one).toBe(1);
  });

  it("cuts off a body that never arrives (408) and frees the slot", async () => {
    process.env.UPLOAD_READ_TIMEOUT_MS = "150";
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    const owner = await makeUser();
    const app = await draft(owner);
    const started = Date.now();
    const slow = await gatedUpload(owner, app.id, { bytes: png(64, 1500), stall: true });
    const res = await slow.response;
    expect(res.status).toBe(408);
    expect(Date.now() - started).toBeLessThan(3000);
    await waitForSlots(0);
  });

  // ---- deletable flag ---------------------------------------------------------------------------------------------

  it("tells the UI which documents can be deleted", async () => {
    const { transitionApplication } = await import("@/lib/applications");
    const { listDocuments } = await import("@/lib/documents");
    const owner = await makeUser();
    const created = await draft(owner, complete);
    const docs = await addTwo(owner, created.id);
    expect(docs.id.deletable).toBe(true);
    expect((await listDocuments(owner, created.id)).map((d) => d.deletable)).toEqual([true, true]);
    const sent = await transitionApplication(owner, created.id, { to: "submitted", version: created.version });
    expect((await listDocuments(owner, created.id)).map((d) => d.deletable)).toEqual([false, false]);
    expect((await listDocuments(quinn, created.id)).map((d) => d.deletable)).toEqual([false, false]);
    const claimed = await transitionApplication(quinn, created.id, { to: "in_review", version: sent.version });
    await transitionApplication(quinn, created.id, { to: "info_requested", version: claimed.version, message: "Another, please." });
    const extra = await (await upload(owner, created.id, { bytes: png(64, 1600), kind: "bank_statement" })).json();
    expect(extra.document.deletable).toBe(true);
    const rows = await listDocuments(owner, created.id);
    expect(Object.fromEntries(rows.map((d) => [d.id, d.deletable]))).toEqual({
      [docs.id.id]: false,
      [docs.pay.id]: false,
      [extra.document.id]: true,
    });
    // The flag and the delete rule agree.
    expect((await remove(owner, docs.id.id)).status).toBe(409);
    expect((await remove(owner, extra.document.id)).status).toBe(204);
  });

});
