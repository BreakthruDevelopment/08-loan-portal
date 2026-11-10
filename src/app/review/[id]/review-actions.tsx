"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogActions, FailureNote } from "@/components/feedback";
import { Field } from "@/components/field";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import type { Failure } from "@/lib/api-errors";
import { MAX_DECISION_CODES, NOTE_MAX, validateDecline, validateMessage } from "@/lib/decision-ui";
import { DECISION_CODES, type ApplicationStatus } from "@/lib/loan";
import { DECISION_CODE_LABELS } from "@/lib/ui-labels";
import { type ReviewTransition, reviewTransitionAction } from "../actions";

type Mode = null | "request" | "approve" | "decline";

/**
 * Claim, release, request information, approve and decline. The buttons shown follow the state table, but the server
 * decides: a stale version (409) offers a refresh, and a refused step shows the server's reason.
 */
export function ReviewActions({
  id,
  version,
  status,
  mine,
  orphaned,
}: {
  id: string;
  version: number;
  status: ApplicationStatus;
  mine: boolean;
  orphaned: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [text, setText] = useState("");

  function close() {
    setMode(null);
    setProblem(null);
    setCodes([]);
    setText("");
  }

  function run(body: ReviewTransition, after?: () => void) {
    setFailure(null);
    start(async () => {
      const result = await reviewTransitionAction(id, body);
      if (!result.ok) {
        // Stale and refused steps are shown on the page, not inside the dialog that is about to close.
        setFailure(result);
        close();
        return;
      }
      after?.();
      close();
      router.refresh();
    });
  }

  const canClaim = status === "submitted";
  const canRelease = status === "in_review" && (mine || orphaned);
  const canDecide = status === "in_review" && mine;

  return (
    <div className="space-y-4" data-review-actions data-can-claim={canClaim} data-can-release={canRelease} data-can-decide={canDecide}>
      {status === "in_review" && !mine && !orphaned && (
        <p className="text-sm text-muted">Another underwriter has this file. Only they can decide it.</p>
      )}
      {status === "in_review" && orphaned && <p className="text-sm text-muted">The underwriter on this file is gone. Release it so it goes back to New.</p>}
      {status === "info_requested" && <p className="text-sm text-muted">Waiting for the applicant to reply. The file comes back to New when they do.</p>}
      {(status === "approved" || status === "declined" || status === "withdrawn") && (
        <p className="text-sm text-muted">This file is closed. No further actions.</p>
      )}

      <div className="flex flex-col gap-3">
        {canClaim && (
          <button type="button" className={buttonPrimary} disabled={pending} onClick={() => run({ to: "in_review", version })}>
            {pending ? "Claiming…" : "Claim this file"}
          </button>
        )}
        {canDecide && (
          <>
            <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setMode("request")}>
              Request information
            </button>
            <button type="button" className={buttonPrimary} disabled={pending} onClick={() => setMode("approve")}>
              Approve
            </button>
            <button type="button" className={buttonDanger} disabled={pending} onClick={() => setMode("decline")}>
              Decline…
            </button>
          </>
        )}
        {canRelease && (
          <button type="button" className={buttonSecondary} disabled={pending} onClick={() => run({ to: "submitted", version })}>
            {pending ? "Releasing…" : "Release to the queue"}
          </button>
        )}
      </div>

      <FailureNote failure={failure} onRefresh={() => router.refresh()} />

      <Dialog open={mode === "request"} onClose={close} title="Request information">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const check = validateMessage(text);
            if (!check.ok) return setProblem(check.message);
            run({ to: "info_requested", version, message: check.message });
          }}
        >
          <Field id="request-message" label="What do you need from the applicant?" hint="They see this message. Up to 1,000 characters." error={problem ?? undefined}>
            {(p) => <textarea rows={5} maxLength={NOTE_MAX} value={text} onChange={(e) => setText(e.target.value)} className={inputClass} {...p} />}
          </Field>
          <DialogActions>
            <button type="button" className={buttonSecondary} onClick={close} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={buttonPrimary} disabled={pending}>
              {pending ? "Sending…" : "Send request"}
            </button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={mode === "approve"} onClose={close} title="Approve this application">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim().length > NOTE_MAX) return setProblem(`The note can be up to ${NOTE_MAX} characters.`);
            run({ to: "approved", version, ...(text.trim() ? { note: text.trim() } : {}) });
          }}
        >
          <p className="text-sm text-muted">The decision is final. You decide; the AI summary doesn&apos;t.</p>
          <Field id="approve-note" label="Note (optional)" hint="Internal. The applicant doesn't see it." error={problem ?? undefined}>
            {(p) => <textarea rows={4} maxLength={NOTE_MAX} value={text} onChange={(e) => setText(e.target.value)} className={inputClass} {...p} />}
          </Field>
          <DialogActions>
            <button type="button" className={buttonSecondary} onClick={close} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={buttonPrimary} disabled={pending}>
              {pending ? "Approving…" : "Approve"}
            </button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={mode === "decline"} onClose={close} title="Decline this application">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const check = validateDecline(codes, text);
            if (!check.ok) return setProblem(check.message);
            run({ to: "declined", version, codes: check.codes, ...(check.note ? { note: check.note } : {}) });
          }}
        >
          <fieldset className="space-y-2" aria-describedby="decline-help">
            <legend className="text-sm font-medium">Reason codes</legend>
            <p id="decline-help" className="text-sm text-muted">
              Choose 1 to {MAX_DECISION_CODES}. The applicant sees these reasons.
            </p>
            {DECISION_CODES.map((code) => {
              const checked = codes.includes(code);
              return (
                <label key={code} className="flex min-h-11 items-center gap-3 rounded-card border border-border px-3 text-sm">
                  <input
                    type="checkbox"
                    name="codes"
                    value={code}
                    checked={checked}
                    disabled={!checked && codes.length >= MAX_DECISION_CODES}
                    onChange={(e) => setCodes((prev) => (e.target.checked ? [...prev, code] : prev.filter((c) => c !== code)))}
                    className="size-5 accent-accent"
                  />
                  <span>{DECISION_CODE_LABELS[code]}</span>
                </label>
              );
            })}
          </fieldset>
          <Field
            id="decline-note"
            label={codes.includes("OTHER") ? "Note (required for OTHER)" : "Note (optional)"}
            hint="Internal. The applicant doesn't see it."
            error={problem ?? undefined}
          >
            {(p) => <textarea rows={3} maxLength={NOTE_MAX} value={text} onChange={(e) => setText(e.target.value)} className={inputClass} {...p} />}
          </Field>
          <DialogActions>
            <button type="button" className={buttonSecondary} onClick={close} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={buttonDanger} disabled={pending}>
              {pending ? "Declining…" : "Decline application"}
            </button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}
