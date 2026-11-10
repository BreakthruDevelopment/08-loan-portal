"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Field } from "@/components/field";
import { FailureNote } from "@/components/feedback";
import { Panel, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui";
import type { Failure } from "@/lib/api-errors";
import type { ApplicationDto, DocumentDto } from "@/lib/dto";
import { formatCents } from "@/lib/format";
import {
  CREDIT_BANDS,
  EMPLOYMENT_STATUSES,
  PURPOSES,
  TERMS,
  type ApplicationFieldValues,
} from "@/lib/loan";
import {
  type FieldErrors,
  type FieldStepId,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
  buildPatch,
  fieldDefaults,
  firstIncompleteStep,
  neighbourStep,
  stepComplete,
  submitBlockers,
} from "@/lib/stepper";
import { CREDIT_BAND_LABELS, EMPLOYMENT_LABELS, PURPOSE_LABELS, label } from "@/lib/ui-labels";
import { applicantTransitionAction, saveApplicationAction } from "../actions";
import { DocumentsManager } from "./documents-manager";

const isFieldStep = (step: StepId): step is FieldStepId => step === "loan" || step === "work" || step === "payments";

/** One of the three field steps. The inputs are uncontrolled; the parent remounts them only to load the latest copy. */
function FieldsStep({
  step,
  application,
  onSaved,
  onBack,
  onReload,
}: {
  step: FieldStepId;
  application: ApplicationDto;
  onSaved: (next: StepId) => void;
  onBack: (previous: StepId) => void;
  /** Re-fetch the server's copy and reset the inputs to it (after a stale save). */
  onReload: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const f: ApplicationFieldValues = application.fields;
  const money = fieldDefaults(f);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const direction = submitter?.value === "back" ? -1 : 1;
    const result = buildPatch(step, new FormData(event.currentTarget));
    setFailure(null);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    start(async () => {
      const saved = await saveApplicationAction(application.id, { version: application.version, ...result.patch });
      if (!saved.ok) {
        setFailure(saved);
        return;
      }
      router.refresh();
      (direction === 1 ? onSaved : onBack)(neighbourStep(step, direction));
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate aria-label={STEP_LABELS[step]}>
      <div className="grid gap-4 sm:grid-cols-2">
        {step === "loan" && (
          <>
            <Field id="amountCents" label="Loan amount (USD)" hint="Between $1,000 and $50,000." error={errors.amountCents}>
              {(p) => <input name="amountCents" inputMode="decimal" autoComplete="off" defaultValue={money.amountCents} className={inputClass} {...p} />}
            </Field>
            <Field id="termMonths" label="Term" error={errors.termMonths}>
              {(p) => (
                <select name="termMonths" defaultValue={f.termMonths ?? ""} className={inputClass} {...p}>
                  <option value="">Choose a term</option>
                  {TERMS.map((t) => (
                    <option key={t} value={t}>
                      {t} months
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="purpose" label="Purpose" error={errors.purpose}>
              {(p) => (
                <select name="purpose" defaultValue={f.purpose ?? ""} className={inputClass} {...p}>
                  <option value="">Choose a purpose</option>
                  {PURPOSES.map((v) => (
                    <option key={v} value={v}>
                      {label(PURPOSE_LABELS, v)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        )}
        {step === "work" && (
          <>
            <Field id="employmentStatus" label="Employment status" error={errors.employmentStatus}>
              {(p) => (
                <select name="employmentStatus" defaultValue={f.employmentStatus ?? ""} className={inputClass} {...p}>
                  <option value="">Choose one</option>
                  {EMPLOYMENT_STATUSES.map((v) => (
                    <option key={v} value={v}>
                      {label(EMPLOYMENT_LABELS, v)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id="employerName" label="Employer name" hint="Leave blank if you aren't working." error={errors.employerName}>
              {(p) => <input name="employerName" maxLength={120} autoComplete="organization" defaultValue={f.employerName ?? ""} className={inputClass} {...p} />}
            </Field>
            <Field id="monthsEmployed" label="Months at this job or in this status" hint="A whole number, 0 to 600." error={errors.monthsEmployed}>
              {(p) => <input name="monthsEmployed" inputMode="numeric" autoComplete="off" defaultValue={f.monthsEmployed ?? ""} className={inputClass} {...p} />}
            </Field>
            <Field id="annualIncomeCents" label="Annual income before tax (USD)" error={errors.annualIncomeCents}>
              {(p) => <input name="annualIncomeCents" inputMode="decimal" autoComplete="off" defaultValue={money.annualIncomeCents} className={inputClass} {...p} />}
            </Field>
          </>
        )}
        {step === "payments" && (
          <>
            <Field id="monthlyHousingCents" label="Monthly rent or mortgage (USD)" error={errors.monthlyHousingCents}>
              {(p) => <input name="monthlyHousingCents" inputMode="decimal" autoComplete="off" defaultValue={money.monthlyHousingCents} className={inputClass} {...p} />}
            </Field>
            <Field id="monthlyDebtCents" label="Other monthly debt payments (USD)" hint="Cards, car loans, student loans. Use 0 if none." error={errors.monthlyDebtCents}>
              {(p) => <input name="monthlyDebtCents" inputMode="decimal" autoComplete="off" defaultValue={money.monthlyDebtCents} className={inputClass} {...p} />}
            </Field>
            <Field id="creditBand" label="Your credit, in your own words" hint="A self-reported estimate. We don't pull a credit report." error={errors.creditBand}>
              {(p) => (
                <select name="creditBand" defaultValue={f.creditBand ?? ""} className={inputClass} {...p}>
                  <option value="">Choose one</option>
                  {CREDIT_BANDS.map((v) => (
                    <option key={v} value={v}>
                      {label(CREDIT_BAND_LABELS, v)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        )}
      </div>
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="text-sm font-medium text-danger">
          Fix the highlighted fields to continue.
        </p>
      )}
      <FailureNote failure={failure} onRefresh={onReload} />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        {step !== "loan" ? (
          <button type="submit" value="back" className={buttonSecondary} disabled={pending}>
            Save and go back
          </button>
        ) : (
          <span />
        )}
        <button type="submit" value="next" className={buttonPrimary} disabled={pending}>
          {pending ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}

function ReviewStep({
  application,
  documents,
  onGo,
}: {
  application: ApplicationDto;
  documents: DocumentDto[];
  onGo: (step: StepId) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reply, setReply] = useState("");
  const f = application.fields;
  const replying = application.status === "info_requested";
  const blockers = submitBlockers(f, documents);
  const rows: [string, string][] = [
    ["Loan amount", formatCents(f.amountCents)],
    ["Term", f.termMonths ? `${f.termMonths} months` : "—"],
    ["Purpose", label(PURPOSE_LABELS, f.purpose)],
    ["Employment", label(EMPLOYMENT_LABELS, f.employmentStatus)],
    ["Employer", f.employerName ?? "—"],
    ["Months employed", f.monthsEmployed === null ? "—" : String(f.monthsEmployed)],
    ["Annual income", formatCents(f.annualIncomeCents)],
    ["Monthly housing", formatCents(f.monthlyHousingCents)],
    ["Other monthly debt", formatCents(f.monthlyDebtCents)],
    ["Credit (self-reported)", label(CREDIT_BAND_LABELS, f.creditBand)],
    ["Documents", documents.length === 0 ? "None yet" : `${documents.length} added`],
  ];

  return (
    <div className="space-y-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-review-summary>
        {rows.map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-4 border-b border-border py-1">
            <dt className="text-muted">{term}</dt>
            <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>

      {blockers.length > 0 ? (
        <div role="status" className="space-y-2 rounded-card border border-border bg-building-soft p-4 text-sm" data-submit-blockers={blockers.length}>
          <p className="font-semibold text-building">Before you can send this in, add:</p>
          <ul className="list-disc space-y-1 pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            {STEP_IDS.slice(0, 4)
              .filter((s) => !stepComplete(s, f, documents))
              .map((s) => (
                <button key={s} type="button" className={buttonSecondary} onClick={() => onGo(s)}>
                  Go to {STEP_LABELS[s].toLowerCase()}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted">
          Everything we need is here.
        </p>
      )}

      {replying && (
        <Field
          id="reply"
          label="Your reply"
          hint="Answer the request above. You can also add a document in the Documents step instead of, or as well as, a reply."
        >
          {(p) => (
            <textarea
              name="reply"
              rows={4}
              maxLength={1000}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              className={inputClass}
              {...p}
            />
          )}
        </Field>
      )}

      <FailureNote failure={failure} onRefresh={() => router.refresh()} />
      <button
        type="button"
        className={buttonPrimary}
        disabled={pending || blockers.length > 0}
        onClick={() =>
          start(async () => {
            setFailure(null);
            const result = await applicantTransitionAction(application.id, {
              to: "submitted",
              version: application.version,
              ...(replying && reply.trim() ? { message: reply.trim() } : {}),
            });
            if (!result.ok) return setFailure(result);
            router.refresh();
          })
        }
      >
        {pending ? "Sending…" : replying ? "Send back to the underwriter" : "Submit application"}
      </button>
    </div>
  );
}

/**
 * Loan -> Work and income -> Monthly payments -> Documents -> Review and submit. Fields save one step at a time with the
 * application's `version`; a stale save offers a refresh. The server enforces every rule again.
 */
export function Stepper({ application, documents }: { application: ApplicationDto; documents: DocumentDto[] }) {
  const router = useRouter();
  const [step, setStep] = useState<StepId>(() => firstIncompleteStep(application.fields, documents));
  // The inputs are uncontrolled and keep what the person typed when a save's refresh lands. They reset to the server's
  // copy only when the person asks for the latest version after a stale save (adjusting state during render, not in an effect).
  const [resetKey, setResetKey] = useState(0);
  const [wantsReload, setWantsReload] = useState(false);
  const [seenVersion, setSeenVersion] = useState(application.version);
  if (application.version !== seenVersion) {
    setSeenVersion(application.version);
    if (wantsReload) {
      setWantsReload(false);
      setResetKey((k) => k + 1);
    }
  }
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Move focus to the new step's heading so keyboard and screen reader users land on it. Not on first render.
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const position = STEP_IDS.indexOf(step) + 1;
  return (
    <Panel title="Your application">
      <div data-stepper data-step={step}>
        <nav aria-label="Application steps" className="mb-5">
          <p className="mb-2 text-sm text-muted">
            Step {position} of {STEP_IDS.length}
          </p>
          <ol className="flex flex-wrap gap-2">
            {STEP_IDS.map((id, index) => {
              const done = id !== "review" && stepComplete(id, application.fields, documents);
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setStep(id)}
                    aria-current={id === step ? "step" : undefined}
                    data-step-button={id}
                    data-step-done={done ? "true" : "false"}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-card border px-3 text-sm font-semibold ${
                      id === step ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground hover:bg-accent-soft"
                    }`}
                  >
                    <span aria-hidden>{done ? "✓" : index + 1}</span>
                    <span>{STEP_LABELS[id]}</span>
                    {done && <span className="sr-only">(complete)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <h2 ref={headingRef} tabIndex={-1} className="mb-4 font-display text-2xl font-semibold outline-none">
          {STEP_LABELS[step]}
        </h2>
        {isFieldStep(step) && (
          <FieldsStep
            key={`${step}-${resetKey}`}
            step={step}
            application={application}
            onSaved={setStep}
            onBack={setStep}
            onReload={() => {
              setWantsReload(true);
              router.refresh();
            }}
          />
        )}
        {step === "documents" && (
          <div className="space-y-4">
            <DocumentsManager applicationId={application.id} documents={documents} />
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
              <button type="button" className={buttonSecondary} onClick={() => setStep("payments")}>
                Back
              </button>
              <button type="button" className={buttonPrimary} onClick={() => setStep("review")}>
                Continue to review
              </button>
            </div>
          </div>
        )}
        {step === "review" && <ReviewStep application={application} documents={documents} onGo={setStep} />}
      </div>
    </Panel>
  );
}
