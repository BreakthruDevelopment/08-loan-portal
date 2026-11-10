"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import type { Failure } from "@/lib/api-errors";
import { applicantTransitionAction } from "../actions";

/** Withdrawing is final, so it takes a second, explicit click. */
export function WithdrawControl({ id, version }: { id: string; version: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);

  return (
    <div className="space-y-3" data-withdraw>
      {!confirming ? (
        <button type="button" className={buttonDanger} onClick={() => setConfirming(true)}>
          Withdraw application
        </button>
      ) : (
        <div className="space-y-3" role="group" aria-label="Confirm withdrawal">
          <p className="text-sm">Withdraw this application? It will be closed and can&apos;t be reopened.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonDanger}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setFailure(null);
                  const result = await applicantTransitionAction(id, { to: "withdrawn", version });
                  if (!result.ok) return setFailure(result);
                  router.refresh();
                })
              }
            >
              {pending ? "Withdrawing…" : "Yes, withdraw"}
            </button>
            <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setConfirming(false)}>
              Keep my application
            </button>
          </div>
        </div>
      )}
      <FailureNote failure={failure} onRefresh={() => router.refresh()} />
    </div>
  );
}
