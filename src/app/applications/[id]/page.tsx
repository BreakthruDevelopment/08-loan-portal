import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationStatusBadge } from "@/components/status-pill";
import { StatusTimeline } from "@/components/status-timeline";
import { PageIntro, Panel } from "@/components/ui";
import { getApplication } from "@/lib/applications";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { toFields, type ApplicationDto, type DocumentDto } from "@/lib/dto";
import { NotFoundError } from "@/lib/errors";
import { formatBytes, formatCents, formatDate, formatDateTime } from "@/lib/format";
import { listDocuments } from "@/lib/documents";
import { isEditableStatus, isFinalStatus, type DecisionCode } from "@/lib/loan";
import { listNotes } from "@/lib/notes";
import {
  CONTENT_TYPE_LABELS,
  CREDIT_BAND_LABELS,
  DECISION_CODE_LABELS,
  DOCUMENT_KIND_LABELS,
  EMPLOYMENT_LABELS,
  PURPOSE_LABELS,
  label,
} from "@/lib/ui-labels";
import { Stepper } from "./stepper";
import { WithdrawControl } from "./withdraw-control";

export const metadata: Metadata = { title: "Application" };
export const dynamic = "force-dynamic";

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRoleOrRedirect("user");
  const { id } = await params;

  let row;
  try {
    row = await getApplication(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [documentRows, notes] = await Promise.all([listDocuments(user, row.id), listNotes(user, row.id)]);

  const application: ApplicationDto = {
    id: row.id,
    status: row.status,
    version: row.version,
    fields: toFields(row),
    decisionCodes: row.decisionCodes ?? [],
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
  const documents: DocumentDto[] = documentRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    displayName: d.displayName,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    uploadedAt: d.uploadedAt.toISOString(),
    deletable: d.deletable,
  }));
  // The data function already limits an applicant to applicant-visible notes and hides who the reviewer is.
  const messages = notes.map((n) => ({
    id: n.id,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
    author: ("author" in n ? n.author : "underwriter") as "you" | "underwriter",
  }));
  const status = application.status;
  const editable = isEditableStatus(status);
  const f = application.fields;

  return (
    <div data-page="application" data-application-status={status} data-application-id={application.id}>
      <PageIntro
        section="Application"
        title={f.amountCents === null ? "New application" : `${formatCents(f.amountCents)} loan`}
        description={
          status === "draft"
            ? "Work through the steps. Your progress is saved as you go."
            : application.submittedAt
              ? `Submitted ${formatDate(application.submittedAt)}.`
              : undefined
        }
        actions={
          <Link href="/applications" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
            ← All applications
          </Link>
        }
      />

      <Panel title="Status" action={<ApplicationStatusBadge status={status} />}>
        <StatusTimeline status={status} />
        {status === "in_review" && <p className="mt-3 text-sm text-muted">An underwriter is reviewing your application. You don&apos;t need to do anything.</p>}
        {status === "submitted" && <p className="mt-3 text-sm text-muted">Your application is in the queue for review.</p>}
        {status === "withdrawn" && <p className="mt-3 text-sm text-muted">You withdrew this application. It is closed.</p>}
      </Panel>

      {status === "info_requested" && (
        <section aria-labelledby="needs-reply" className="mb-6 rounded-card border border-border bg-building-soft p-4 sm:p-5" data-needs-reply>
          <h2 id="needs-reply" className="font-display text-xl font-semibold text-building">
            We need more information
          </h2>
          <p className="mt-1 text-sm">Read the message below, then add a document or reply on the Review step and send the application back.</p>
        </section>
      )}

      {(status === "approved" || status === "declined") && (
        <Panel title="Decision">
          {status === "approved" ? (
            <p data-decision="approved">Your application was approved{application.decidedAt ? ` on ${formatDate(application.decidedAt)}` : ""}.</p>
          ) : (
            <div className="space-y-2" data-decision="declined">
              <p>Your application was declined{application.decidedAt ? ` on ${formatDate(application.decidedAt)}` : ""}. Reasons:</p>
              <ul className="list-disc space-y-1 pl-5">
                {application.decisionCodes.map((code) => (
                  <li key={code} data-decision-code={code}>
                    {DECISION_CODE_LABELS[code as DecisionCode] ?? code}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Messages" count={messages.length}>
        {messages.length === 0 ? (
          <p className="text-sm text-muted">No messages yet. If an underwriter needs something, it will appear here.</p>
        ) : (
          <ul className="space-y-3" data-messages>
            {messages.map((m) => (
              <li key={m.id} className="rounded-card border border-border bg-background p-3" data-message-author={m.author}>
                <p className="text-sm text-muted">
                  {m.author === "you" ? "You" : "Underwriter"} · {formatDateTime(m.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {editable ? (
        <Stepper application={application} documents={documents} />
      ) : (
        <>
          <Panel title="Your application">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-application-summary>
              {(
                [
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
                ] as [string, string][]
              ).map(([term, value]) => (
                <div key={term} className="flex items-baseline justify-between gap-4 border-b border-border py-1">
                  <dt className="text-muted">{term}</dt>
                  <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel title="Your documents" count={documents.length}>
            <ReadOnlyDocuments documents={documents} />
          </Panel>
        </>
      )}

      {!isFinalStatus(status) && (
        <Panel title="Withdraw">
          <p className="mb-3 text-sm text-muted">Changed your mind? You can withdraw this application at any time before a decision.</p>
          <WithdrawControl id={application.id} version={application.version} />
        </Panel>
      )}
    </div>
  );
}

/** A plain list for files that can no longer change. The applicant can still download their own copies. */
function ReadOnlyDocuments({ documents }: { documents: DocumentDto[] }) {
  if (documents.length === 0) return <p className="text-sm text-muted">No documents were added.</p>;
  return (
    <ul className="divide-y divide-border" data-documents-count={documents.length}>
      {documents.map((doc) => (
        <li key={doc.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between" data-document-id={doc.id} data-deletable="false">
          <a href={`/api/documents/${doc.id}`} download className="inline-flex min-h-11 items-center break-all font-medium text-accent hover:underline">
            {doc.displayName}
          </a>
          <span className="text-sm text-muted">
            {DOCUMENT_KIND_LABELS[doc.kind]} · {label(CONTENT_TYPE_LABELS, doc.contentType)} · {formatBytes(doc.sizeBytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}

