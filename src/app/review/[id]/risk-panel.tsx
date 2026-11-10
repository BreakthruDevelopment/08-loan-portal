"use client";

import { useEffect, useState, useTransition } from "react";
import { DemoBadge, StatusBadge, buttonPrimary, buttonSecondary } from "@/components/ui";
import { FailureNote } from "@/components/feedback";
import { type Failure, describeFailure, parseRetryAfter } from "@/lib/api-errors";
import { formatCents, formatDateTime, formatPercent } from "@/lib/format";
import { CREDIT_BAND_LABELS, DOCUMENT_KIND_LABELS, label } from "@/lib/ui-labels";
import type { DocumentKind } from "@/lib/loan";
import type { RiskView } from "@/lib/risk";

type Risk = Omit<RiskView, "summary" | "metrics"> & {
  metrics: Omit<RiskView["metrics"], "documents"> & { documents: Record<string, number> };
  summary: (Omit<NonNullable<RiskView["summary"]>, "generatedAt"> & { generatedAt: string }) | null;
};

const SEVERITY: Record<string, { label: string; tone: "blocked" | "degraded" | "not-started" }> = {
  high: { label: "High", tone: "blocked" },
  medium: { label: "Medium", tone: "degraded" },
  info: { label: "Info", tone: "not-started" },
};

async function readFailure(response: Response): Promise<Failure> {
  let message: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Not JSON: use the status wording.
  }
  return describeFailure({ status: response.status, message, retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")) });
}

/**
 * The advisory risk panel. Metrics and flags come from deterministic rules and are always shown; the AI summary is
 * optional, labelled advisory, and marked Demo when it is a recorded fixture. Talks to GET/POST /api/applications/:id/risk.
 */
export function RiskPanel({ applicationId, applicationVersion }: { applicationId: string; applicationVersion: number }) {
  const [risk, setRisk] = useState<Risk | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, start] = useTransition();
  const [reload, setReload] = useState(0);
  // Load on mount and whenever the application's version changes (a claim, a release, an edit) or the user asks again.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`/api/applications/${applicationId}/risk`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const next = await readFailure(response);
          if (controller.signal.aborted) return;
          setFailure(next);
          setRisk(null);
        } else {
          const body = (await response.json()) as { risk: Risk };
          if (controller.signal.aborted) return;
          setFailure(null);
          setRisk(body.risk);
        }
      } catch {
        if (controller.signal.aborted) return;
        setFailure(describeFailure({ status: 0 }));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [applicationId, applicationVersion, reload]);

  function refetch() {
    setLoading(true);
    setReload((n) => n + 1);
  }

  function generate(regenerate: boolean) {
    setFailure(null);
    start(async () => {
      try {
        const response = await fetch(`/api/applications/${applicationId}/risk`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(regenerate ? { regenerate: true } : {}),
        });
        if (!response.ok) {
          // 409 (allowance used or the file changed) and 429 (hourly or daily limit) keep the rule flags on screen.
          setFailure(await readFailure(response));
          return;
        }
        setRisk(((await response.json()) as { risk: Risk }).risk);
      } catch {
        setFailure(describeFailure({ status: 0 }));
      }
    });
  }

  if (loading && !risk) {
    return (
      <p role="status" className="text-sm text-muted" data-risk-state="loading">
        Loading the risk rules…
      </p>
    );
  }
  if (!risk) {
    return (
      <div className="space-y-3" data-risk-state="error">
        <FailureNote failure={failure ?? { message: "The risk panel couldn't be loaded.", stale: false }} />
        <button type="button" className={buttonSecondary} onClick={refetch}>
          Try again
        </button>
      </div>
    );
  }

  const m = risk.metrics;
  const summary = risk.summary;
  const metricRows: [string, string][] = [
    ["Monthly income", formatCents(m.monthlyIncomeCents)],
    ["Estimated new payment", `${formatCents(m.newPaymentCents)} at ${m.assumedAprPct}% (demo rate)`],
    ["Debt-to-income, with the new payment", formatPercent(m.dtiPct)],
    ["Loan to annual income", formatPercent(m.ltiPct)],
    ["Months employed", String(m.monthsEmployed)],
    ["Credit band (self-reported)", label(CREDIT_BAND_LABELS, m.creditBand)],
    [
      "Documents",
      Object.entries(m.documents)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${DOCUMENT_KIND_LABELS[kind as DocumentKind] ?? kind} ×${n}`)
        .join(", ") || "None",
    ],
  ];

  return (
    <div className="space-y-5" data-risk-state="ready" data-risk-mode={summary?.mode ?? "none"}>
      <p className="rounded-card border border-border bg-accent-soft px-3 py-2 text-sm" data-risk-disclaimer>
        <strong>Advisory.</strong> {risk.disclaimer}
      </p>

      <section aria-labelledby="risk-flags">
        <h3 id="risk-flags" className="mb-2 font-semibold">
          Rule flags
        </h3>
        {risk.flags.length === 0 ? (
          <p className="text-sm text-muted">No rule flags were raised.</p>
        ) : (
          <ul className="space-y-3">
            {risk.flags.map((flag) => (
              <li key={flag.code} className="space-y-1 rounded-card border border-border bg-background p-3" data-risk-flag={flag.code}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={SEVERITY[flag.severity]?.tone ?? "not-started"} label={SEVERITY[flag.severity]?.label ?? flag.severity} />
                  <span className="font-mono text-sm">{flag.code}</span>
                </div>
                <p className="break-words">{flag.reason}</p>
                <p className="text-sm text-muted break-words">Rule: {flag.rule}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="risk-metrics">
        <h3 id="risk-metrics" className="mb-2 font-semibold">
          Computed metrics
        </h3>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {metricRows.map(([term, value]) => (
            <div key={term} className="flex items-baseline justify-between gap-4 border-b border-border py-1">
              <dt className="text-muted">{term}</dt>
              <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="risk-summary" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="risk-summary" className="font-semibold">
            AI summary
          </h3>
          {summary?.mode === "demo" && <DemoBadge label="Demo: recorded, not a live model" />}
          {summary?.mode === "fallback" && <DemoBadge label="Rule reasons only" />}
          {summary?.mode === "live" && <DemoBadge label="Live model" />}
        </div>

        {risk.outdated && (
          <p role="status" className="text-sm text-building" data-risk-outdated>
            The application changed since the last summary, so it was cleared. Generate a new one.
          </p>
        )}
        {risk.unavailable && (
          <p role="status" className="rounded-card border border-border bg-building-soft px-3 py-2 text-sm text-building" data-risk-unavailable>
            The AI summary is unavailable right now. {summary ? "The last saved summary is shown." : "The rule flags above are still correct."} Try again later.
          </p>
        )}

        {summary ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap break-words" data-risk-summary-text>
              {summary.data.summary}
            </p>
            {summary.data.strengths.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold">Strengths</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {summary.data.strengths.map((s, i) => (
                    <li key={i} className="break-words">
                      {s.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.data.concerns.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold">Concerns</h4>
                <ul className="space-y-2 text-sm">
                  {summary.data.concerns.map((c, i) => {
                    const flag = risk.flags.find((f) => f.code === c.flag);
                    return (
                      <li key={i} className="break-words rounded-card border border-border p-2">
                        <span className="font-mono">{c.flag}</span>: {c.text}
                        {flag && <span className="mt-1 block text-muted">Rule reason: {flag.reason}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {summary.data.questionsForApplicant.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold">Questions you might ask</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {summary.data.questionsForApplicant.map((q, i) => (
                    <li key={i} className="break-words">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm text-muted">
              Generated {formatDateTime(summary.generatedAt)} · {summary.regenerationsLeft} regeneration{summary.regenerationsLeft === 1 ? "" : "s"} left for this version.
            </p>
          </div>
        ) : (
          !risk.outdated && <p className="text-sm text-muted">No AI summary yet. The rule flags above don&apos;t need one.</p>
        )}

        <FailureNote failure={failure} onRefresh={refetch} refreshing={loading} />

        <div className="flex flex-wrap gap-3">
          {!summary ? (
            <button type="button" className={buttonPrimary} disabled={pending} onClick={() => generate(false)}>
              {pending ? "Generating…" : "Generate AI summary"}
            </button>
          ) : (
            <button
              type="button"
              className={buttonSecondary}
              disabled={pending || summary.regenerationsLeft <= 0}
              aria-describedby={summary.regenerationsLeft <= 0 ? "no-regen" : undefined}
              onClick={() => generate(true)}
            >
              {pending ? "Regenerating…" : "Regenerate"}
            </button>
          )}
        </div>
        {summary && summary.regenerationsLeft <= 0 && (
          <p id="no-regen" className="text-sm text-muted">
            This version of the application has used all its regenerations.
          </p>
        )}
      </section>
    </div>
  );
}
