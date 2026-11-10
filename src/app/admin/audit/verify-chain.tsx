"use client";

import { useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { buttonPrimary } from "@/components/ui/styles";
import { type Failure, describeFailure, parseRetryAfter } from "@/lib/api-errors";

type Result = { ok: true; checked: number } | { ok: false; id: number; reason: string };

/** POSTs to the verify route and shows the walk's result: intact, or the first broken link. */
export function VerifyChain() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  return (
    <div className="space-y-3" data-audit-verify>
      <button
        type="button"
        className={buttonPrimary}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setFailure(null);
            setResult(null);
            try {
              const response = await fetch("/api/admin/audit/verify", { method: "POST" });
              if (!response.ok) {
                let message: string | null = null;
                try {
                  message = ((await response.json()) as { error?: string }).error ?? null;
                } catch {
                  // Use the status wording.
                }
                setFailure(describeFailure({ status: response.status, message, retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")) }));
                return;
              }
              setResult(((await response.json()) as { result: Result }).result);
            } catch {
              setFailure(describeFailure({ status: 0 }));
            }
          })
        }
      >
        {pending ? "Verifying…" : "Verify chain"}
      </button>
      <div aria-live="polite">
        {result?.ok && (
          <p className="rounded-card border border-border bg-live-soft px-3 py-2 text-sm font-medium text-live" data-verify-result="intact">
            Chain intact: {result.checked} events checked, no gaps or edits found.
          </p>
        )}
        {result && !result.ok && (
          <p role="alert" className="rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm font-medium text-blocked" data-verify-result="broken" data-broken-id={result.id}>
            Chain broken at event #{result.id}: {result.reason}.
          </p>
        )}
      </div>
      <FailureNote failure={failure} />
    </div>
  );
}
