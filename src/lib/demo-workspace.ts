import "server-only";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import { addDocument } from "@/lib/documents";
import { auth } from "@/lib/auth";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_PDF, DEMO_PNG } from "@/lib/demo-files";
import { isDemoEmail, MARKER } from "@/lib/demo-identity";
import { env } from "@/lib/env";
import { ConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { addNote } from "@/lib/notes";
import { createApplication, transitionApplication } from "@/lib/applications";
import { reserveDaily, type Tx } from "@/lib/usage";

/** App-wide cap so a script can't rebuild the workspace all day. */
export const DEMO_LOAD_DAILY_CAP = 48;

const DEMO_ACCOUNTS = [
  { key: "ada", email: "ada@demo.breakthru.test", name: "Ada Applicant", role: "user" },
  { key: "ben", email: "ben@demo.breakthru.test", name: "Ben Applicant", role: "user" },
  { key: "quinn", email: "quinn@demo.breakthru.test", name: "Quinn Underwriter", role: "underwriter" },
  { key: "admin", email: "admin@demo.breakthru.test", name: "Demo Admin", role: "admin" },
] as const;

const ADA_SUBMITTED = {
  amountCents: 1_500_000,
  termMonths: 36 as const,
  purpose: "debt_consolidation" as const,
  employmentStatus: "employed" as const,
  employerName: "Northwind Credit",
  monthsEmployed: 36,
  annualIncomeCents: 7_200_000,
  monthlyHousingCents: 150_000,
  monthlyDebtCents: 40_000,
  creditBand: "good" as const,
};

const BEN_IN_REVIEW = {
  ...ADA_SUBMITTED,
  amountCents: 800_000,
  termMonths: 24 as const,
  purpose: "home_improvement" as const,
  employerName: "Harbor Mutual",
  creditBand: "fair" as const,
};

export type DemoLoadResult = { loaded: true; applications: number };

/**
 * Replace the demo workspace: two applicants, three applications, one underwriter, one admin.
 * Audit rows stay (the log is append-only). An email that already exists without the demo
 * marker is left alone. Call `assertDemoTargetAllowed` before this from the admin button,
 * and `demoSeedConfig` before importing this module from the CLI.
 */
export async function loadDemoWorkspace(input: {
  actor: Actor;
  actorEmail?: string | null;
  password: string;
}): Promise<DemoLoadResult> {
  if (input.actor.role !== "admin") throw new ForbiddenError();
  if (input.actorEmail && isDemoEmail(input.actorEmail)) {
    throw new ForbiddenError("Load the demo from an admin account that isn't part of the demo workspace.");
  }

  const emails = DEMO_ACCOUNTS.map((account) => account.email);
  // Session lock so two loads can't delete and recreate the same emails at once.
  // The transaction lock inside `usage` ends when that transaction commits.
  const lock = postgres(env().DATABASE_URL, { max: 1 });
  try {
    await lock`select pg_advisory_lock(hashtextextended(${"demo-workspace"}, 0))`;
    await db().transaction(async (tx) => {
      await clearDemoUsers(tx, emails);
      const reserved = await reserveDaily(tx, "demo_load", DEMO_LOAD_DAILY_CAP);
      if (!reserved) throw new ConflictError("The demo workspace can only be loaded a few times today.");
    });

    const ids = await createDemoUsers(input.password);
    await seedApplications(ids);
    log.info("demo.loaded", { applications: 3 });
    return { loaded: true, applications: 3 };
  } finally {
    await lock`select pg_advisory_unlock(hashtextextended(${"demo-workspace"}, 0))`.catch(() => {});
    await lock.end();
  }
}

async function clearDemoUsers(tx: Tx, emails: string[]) {
  const existing = await tx
    .select({ id: schema.user.id, email: schema.user.email, image: schema.user.image })
    .from(schema.user)
    .where(inArray(schema.user.email, emails));
  const foreign = existing.find((row) => row.image !== MARKER);
  if (foreign) {
    throw new ConflictError("A demo email belongs to an account this loader did not create.");
  }
  const ids = existing.map((row) => row.id);
  if (ids.length === 0) return;
  await tx.delete(schema.application).where(inArray(schema.application.applicantId, ids));
  await tx.delete(schema.user).where(inArray(schema.user.id, ids));
}

async function createDemoUsers(password: string): Promise<Record<(typeof DEMO_ACCOUNTS)[number]["key"], string>> {
  const ids = {} as Record<(typeof DEMO_ACCOUNTS)[number]["key"], string>;
  for (const account of DEMO_ACCOUNTS) {
    const created = await auth().api.createUser({
      body: {
        email: account.email,
        password,
        name: account.name,
        role: account.role,
        data: { image: MARKER },
      },
    });
    await db().update(schema.user).set({ image: MARKER, role: account.role }).where(inArray(schema.user.id, [created.user.id]));
    ids[account.key] = created.user.id;
  }
  return ids;
}

async function seedApplications(ids: Record<(typeof DEMO_ACCOUNTS)[number]["key"], string>) {
  const ada: Actor = { id: ids.ada, role: "user" };
  const ben: Actor = { id: ids.ben, role: "user" };
  const quinn: Actor = { id: ids.quinn, role: "underwriter" };

  await createApplication(ada, { amountCents: 250_000, purpose: "vehicle" });

  const submitted = await createApplication(ada, ADA_SUBMITTED);
  await addDocument(ada, submitted.id, { kind: "id", displayName: "id.pdf", bytes: DEMO_PDF });
  await addDocument(ada, submitted.id, { kind: "pay_stub", displayName: "pay-stub.png", bytes: DEMO_PNG });
  await transitionApplication(ada, submitted.id, { to: "submitted", version: submitted.version });

  const review = await createApplication(ben, BEN_IN_REVIEW);
  await addDocument(ben, review.id, { kind: "id", displayName: "id.png", bytes: DEMO_PNG });
  await addDocument(ben, review.id, { kind: "bank_statement", displayName: "statement.pdf", bytes: DEMO_PDF });
  const sent = await transitionApplication(ben, review.id, { to: "submitted", version: review.version });
  await transitionApplication(quinn, review.id, { to: "in_review", version: sent.version });
  await addNote(quinn, review.id, { visibility: "internal", body: "Bank statement is the only income document." });
  await addNote(quinn, review.id, {
    visibility: "applicant",
    body: "Please confirm the deposits on the statement are your pay.",
  });
}
