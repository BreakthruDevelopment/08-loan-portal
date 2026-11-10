"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import type { Failure } from "@/lib/api-errors";
import { deleteDraftAction } from "./actions";

/** Two steps, so a draft (and its documents) isn't deleted by one stray tap. */
export function DeleteDraftButton({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);

  if (!confirming) {
    return (
      <button type="button" className={buttonDanger} onClick={() => setConfirming(true)}>
        Delete draft
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">Delete this draft and its documents?</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonDanger}
          disabled={pending}
          onClick={() =>
            start(async () => {
              setFailure(null);
              const result = await deleteDraftAction(id);
              if (!result.ok) return setFailure(result);
              router.refresh();
            })
          }
        >
          {pending ? "Deleting…" : "Yes, delete"}
        </button>
        <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
      <FailureNote failure={failure} />
    </div>
  );
}
