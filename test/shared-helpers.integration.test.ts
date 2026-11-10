/**
 * Shared helpers against a real Postgres (TEST_DATABASE_URL): ownedBy scopes rows to their owner,
 * and errorResponse never logs query parameters from a failing statement (template issue #16).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("shared helpers (Postgres)", () => {
  let sql: postgres.Sql;
  let database: ReturnType<typeof import("@/lib/db").db>;
  let schema: typeof import("@/lib/db").schema;
  const alice = { id: "sh-alice" };
  const bob = { id: "sh-bob" };
  const admin = { id: "sh-admin" };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'sh-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id, name, email) values (${u.id}, ${u.id}, ${u.id + "@test.local"})`;
    const dbModule = await import("@/lib/db");
    database = dbModule.db();
    schema = dbModule.schema;
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'sh-%'`;
    await sql.end();
  });

  it("ownedBy: tables keyed by userId stay with that user, and extra conditions are ANDed", async () => {
    const { eq } = await import("drizzle-orm");
    const { ownedBy } = await import("@/lib/owned");
    await database.insert(schema.rateEvent).values({ userId: alice.id, kind: "upload" });
    expect(await database.select().from(schema.rateEvent).where(ownedBy(schema.rateEvent, alice))).toHaveLength(1);
    expect(await database.select().from(schema.rateEvent).where(ownedBy(schema.rateEvent, bob))).toHaveLength(0);
    expect(await database.select().from(schema.rateEvent).where(ownedBy(schema.rateEvent, admin))).toHaveLength(0);
    expect(
      await database.select().from(schema.rateEvent).where(ownedBy(schema.rateEvent, alice, eq(schema.rateEvent.kind, "risk"))),
    ).toHaveLength(0);
  });

  it("errorResponse on a real failing insert logs the SQLSTATE and constraint, never the parameters", async () => {
    const { log } = await import("@/lib/log");
    const { errorResponse } = await import("@/lib/http");
    const canary = "secret-canary@example.com";
    await sql`insert into "user" (id, name, email) values ('sh-dup', 'dup', ${canary})`;
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const err = await database.insert(schema.user).values({ id: "sh-dup2", name: "secret-canary-name", email: canary }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(canary); // the premise: drizzle puts the parameters in the message
      const res = errorResponse(err);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(canary);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain(canary);
      expect(logged).not.toContain("secret-canary-name");
      expect(logged).not.toContain("insert into");
      expect(logged).toContain("23505");
    } finally {
      spy.mockRestore();
    }
  });
});
