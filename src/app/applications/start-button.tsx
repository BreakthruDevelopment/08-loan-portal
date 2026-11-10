"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { buttonPrimary } from "@/components/ui/styles";
import type { Failure } from "@/lib/api-errors";
import { startApplicationAction } from "./actions";

export function StartApplicationButton({ disabledReason }: { disabledReason?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={buttonPrimary}
        disabled={pending || Boolean(disabledReason)}
        aria-describedby={disabledReason ? "start-disabled" : undefined}
        onClick={() =>
          start(async () => {
            setFailure(null);
            const result = await startApplicationAction();
            if (!result.ok) {
              setFailure(result);
              return;
            }
            router.push(`/applications/${result.data.id}`);
          })
        }
      >
        {pending ? "Starting…" : "Start an application"}
      </button>
      {disabledReason && (
        <p id="start-disabled" className="text-sm text-muted">
          {disabledReason}
        </p>
      )}
      <FailureNote failure={failure} />
    </div>
  );
}
