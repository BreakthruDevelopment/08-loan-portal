import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { canReadApplication, contentWhere } from "@/lib/access";
import { appendAudit } from "@/lib/audit";
import { type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { parseUuid } from "@/lib/loan";
import { inputHash, summarizeRisk } from "@/lib/risk-ai";
import { type RiskAssessment, type RiskInput, type RuleFlag, assessRisk, type RiskMetrics } from "@/lib/risk-rules";
import type { RiskSummaryData, RiskSummaryMode } from "@/lib/risk-schema";
import { type Executor, type Tx, advisoryLock, consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

/** Per underwriter, per hour. */
export const RISK_HOURLY_LIMIT = 20;
/** Regenerations allowed for one version of one application. */
export const RISK_MAX_REGENERATIONS = 3;
export const RISK_DISCLAIMER = "AI summary to assist review. The underwriter makes the decision.";

export const generateRiskBody = z.object({ regenerate: z.boolean().optional() }).strict();

export type RiskSummaryView = {
  mode: RiskSummaryMode;
  provider: string;
  generatedAt: Date;
  regenerationsLeft: number;
  data: RiskSummaryData;
};

export type RiskView = {
  applicationId: string;
  applicationVersion: number;
  /** Always computed from the current application by the deterministic rules. */
  metrics: RiskMetrics;
  /** Every flag with its reason and rule reference. Shown even when `summary` is null. */
  flags: RuleFlag[];
  /** Null until generated, and again after the application changes. */
  summary: RiskSummaryView | null;
  /** A summary exists for an older version of the application; generate a new one. */
  outdated: boolean;
  /** True when the model was unavailable. `summary` is then the cached one (a failed regeneration) or the rule reasons only (never stored). */
  unavailable?: boolean;
  disclaimer: string;
};

type Row = typeof schema.application.$inferSelect;

function toRiskInput(row: Row, documentKinds: RiskInput["documentKinds"]): RiskInput {
  if (
    row.amountCents === null ||
    row.termMonths === null ||
    row.employmentStatus === null ||
    row.monthsEmployed === null ||
    row.annualIncomeCents === null ||
    row.monthlyHousingCents === null ||
    row.monthlyDebtCents === null ||
    row.creditBand === null
  ) {
    throw new ConflictError("This application is missing fields the risk rules need.");
  }
  return {
    amountCents: row.amountCents,
    termMonths: row.termMonths,
    employmentStatus: row.employmentStatus,
    monthsEmployed: row.monthsEmployed,
    annualIncomeCents: row.annualIncomeCents,
    monthlyHousingCents: row.monthlyHousingCents,
    monthlyDebtCents: row.monthlyDebtCents,
    creditBand: row.creditBand,
    documentKinds,
  };
}

/** Underwriters only, and only for submitted applications. Everyone else gets the same 404 as a missing id. */
async function loadAssessment(tx: Executor, actor: Actor, applicationId: string) {
  if (actor.role !== "underwriter") throw new NotFoundError();
  const id = parseUuid(applicationId);
  const [row] = await tx.select().from(schema.application).where(and(eq(schema.application.id, id), contentWhere(actor)));
  if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
  // Kinds only: never names, never bytes.
  const docs = await tx
    .select({ kind: schema.document.kind })
    .from(schema.document)
    .where(and(eq(schema.document.applicationId, id), eq(schema.document.applicantId, row.applicantId), isNull(schema.document.deletedAt)));
  const assessment = assessRisk(toRiskInput(row, docs.map((d) => d.kind)));
  return { id, row, assessment, hash: inputHash(assessment) };
}

function viewOf(
  id: string,
  version: number,
  assessment: RiskAssessment,
  stored: typeof schema.riskSummary.$inferSelect | null,
  outdated: boolean,
): RiskView {
  return {
    applicationId: id,
    applicationVersion: version,
    metrics: assessment.metrics,
    flags: assessment.flags,
    summary: stored
      ? {
          mode: stored.mode as RiskSummaryMode,
          provider: stored.mode === "demo" ? "demo" : stored.mode === "fallback" ? "none" : "live",
          generatedAt: stored.generatedAt,
          regenerationsLeft: Math.max(0, RISK_MAX_REGENERATIONS - stored.regenerations),
          data: stored.data as RiskSummaryData,
        }
      : null,
    outdated,
    disclaimer: RISK_DISCLAIMER,
  };
}

async function storedFor(tx: Executor, id: string, hash: string) {
  const rows = await tx.select().from(schema.riskSummary).where(eq(schema.riskSummary.applicationId, id));
  return { current: rows.find((r) => r.inputHash === hash) ?? null, outdated: rows.some((r) => r.inputHash !== hash) };
}

/** GET: the rules' metrics and flags, plus the cached summary if it still matches the application. */
export async function getRiskView(actor: Actor, applicationId: string): Promise<RiskView> {
  const { id, row, assessment, hash } = await loadAssessment(db(), actor, applicationId);
  const { current, outdated } = await storedFor(db(), id, hash);
  return viewOf(id, row.version, assessment, current, outdated);
}

type Plan = { kind: "cached"; view: RiskView } | { kind: "generate"; assessment: RiskAssessment; hash: string; replacing: boolean };

/**
 * POST: return the cached summary, or generate one. The rate limit and the daily cap are taken in one short
 * transaction before the model call, and refunded if the model could not be used. The model call itself holds no
 * transaction. The result is stored only if the application is unchanged when it comes back.
 */
export async function generateRiskView(actor: Actor, applicationId: string, input: unknown): Promise<RiskView> {
  const body = generateRiskBody.parse(input ?? {});
  const regenerate = body.regenerate === true;

  const plan = await db().transaction(async (tx): Promise<Plan> => {
    const loaded = await loadAssessment(tx, actor, applicationId);
    await advisoryLock(tx, `risk:${loaded.id}`);
    const { current, outdated } = await storedFor(tx, loaded.id, loaded.hash);
    if (current && !regenerate) return { kind: "cached", view: viewOf(loaded.id, loaded.row.version, loaded.assessment, current, outdated) };
    if (current && current.regenerations >= RISK_MAX_REGENERATIONS) {
      throw new ConflictError(`This summary was already regenerated ${RISK_MAX_REGENERATIONS} times for this version of the application.`);
    }
    await consumeRate(tx, actor.id, "risk", RISK_HOURLY_LIMIT, `You can generate ${RISK_HOURLY_LIMIT} risk summaries an hour. Try again later.`);
    if (!(await reserveDaily(tx, "risk", env().RISK_DAILY_CAP))) {
      throw new TooManyRequestsError("The daily limit for AI risk summaries has been reached. The rule flags are still shown.");
    }
    return { kind: "generate", assessment: loaded.assessment, hash: loaded.hash, replacing: current !== null };
  });
  if (plan.kind === "cached") return plan.view;

  const result = await summarizeRisk(plan.assessment);

  if (result.modelFailed) {
    await db().transaction(async (tx) => {
      await releaseRate(tx, actor.id, "risk");
      await releaseDaily(tx, "risk");
    });
    const loaded = await loadAssessment(db(), actor, applicationId);
    // A failed regeneration keeps what is stored (and its real allowance), and says the model was unavailable.
    const { current } = await storedFor(db(), loaded.id, loaded.hash);
    if (current) return { ...viewOf(loaded.id, loaded.row.version, loaded.assessment, current, false), unavailable: true };
    return {
      ...viewOf(loaded.id, loaded.row.version, plan.assessment, null, false),
      summary: {
        mode: "fallback",
        provider: "none",
        generatedAt: new Date(),
        regenerationsLeft: RISK_MAX_REGENERATIONS,
        data: result.data,
      },
      unavailable: true,
    };
  }

  return db().transaction(async (tx) => {
    if (actor.role !== "underwriter") throw new NotFoundError();
    // Same lock the application's own writers take, so the version we read can't move under us.
    await advisoryLock(tx, `application:${parseUuid(applicationId)}`);
    const fresh = await loadAssessment(tx, actor, applicationId);
    await advisoryLock(tx, `risk:${fresh.id}`);
    if (fresh.hash !== plan.hash) {
      throw new ConflictError("This application changed while the summary was being written. Generate it again.");
    }
    const { current } = await storedFor(tx, fresh.id, fresh.hash);
    // Another request stored one first, or the regeneration allowance ran out meanwhile: keep what is stored.
    if (current && (!plan.replacing || current.regenerations >= RISK_MAX_REGENERATIONS)) {
      return viewOf(fresh.id, fresh.row.version, fresh.assessment, current, false);
    }
    const values = {
      applicationId: fresh.id,
      inputHash: fresh.hash,
      appVersion: fresh.row.version,
      metrics: fresh.assessment.metrics as unknown as Record<string, unknown>,
      ruleFlags: fresh.assessment.flags as unknown[],
      data: result.data as unknown as Record<string, unknown>,
      mode: result.mode,
      generatedBy: actor.id,
      generatedAt: new Date(),
    };
    const [stored] = await tx
      .insert(schema.riskSummary)
      .values({ ...values, regenerations: 0 })
      .onConflictDoUpdate({
        target: [schema.riskSummary.applicationId, schema.riskSummary.inputHash],
        set: { ...values, regenerations: (current?.regenerations ?? 0) + 1 },
      })
      .returning();
    // Summaries for older versions of this application are stale; remove them.
    await tx
      .delete(schema.riskSummary)
      .where(and(eq(schema.riskSummary.applicationId, fresh.id), ne(schema.riskSummary.inputHash, fresh.hash)));
    await appendAudit(tx as Tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: "risk_summary.generated",
      applicationId: fresh.id,
      // Ids and codes only: no amounts, no text.
      detail: {
        mode: result.mode,
        provider: result.provider,
        flags: fresh.assessment.flags.map((f) => f.code),
        guardrails: result.guardrails,
        regenerated: plan.replacing,
        appVersion: fresh.row.version,
      },
    });
    log.info("risk.stored", { applicationId: fresh.id, mode: result.mode });
    return viewOf(fresh.id, fresh.row.version, fresh.assessment, stored, false);
  });
}
