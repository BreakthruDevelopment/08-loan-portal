import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationStatusBadge } from "@/components/status-pill";
import { DemoBadge, PageIntro, Panel } from "@/components/ui";
import { getApplication, listQueue } from "@/lib/applications";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listDocuments } from "@/lib/documents";
import { toFields, type DocumentDto } from "@/lib/dto";
import { NotFoundError } from "@/lib/errors";
import { formatCents, formatDate, formatDateTime, shortId } from "@/lib/format";
import { listNotes } from "@/lib/notes";
import {
  CREDIT_BAND_LABELS,
  DECISION_CODE_LABELS,
  EMPLOYMENT_LABELS,
  PURPOSE_LABELS,
  label,
} from "@/lib/ui-labels";
import type { DecisionCode } from "@/lib/loan";
import { AddNoteForm } from "./add-note-form";
import { ReviewActions } from "./review-actions";
import { ReviewDocuments } from "./review-documents";
import { RiskPanel } from "./risk-panel";

export const metadata: Metadata = { title: "Review application" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRoleOrRedirect("underwriter");
  const { id } = await params;

  let row;
  try {
    // Opening a file is recorded in the audit log (at most once an hour per underwriter and file).
    row = await getApplication(user, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [documentRows, notes] = await Promise.all([listDocuments(user, row.id), listNotes(user, row.id)]);

  const mine = row.assignedUnderwriterId === user.id;
  // Orphaned: in review, but nobody can act on it. The queue's "new" list is exactly those files, so ask it.
  const orphaned = row.status === "in_review" && !mine ? (await listQueue(user, "new")).some((r) => r.id === row.id) : false;

  const documents: DocumentDto[] = documentRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    displayName: d.displayName,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    uploadedAt: d.uploadedAt.toISOString(),
    deletable: false,
  }));
  const f = toFields(row);
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
  ];

  return (
    <div data-page="review" data-application-id={row.id} data-application-status={row.status}>
      <PageIntro
        section="Review"
        title={`Application #${shortId(row.id)}`}
        description={`Submitted ${formatDate(row.submittedAt)}. ${
          mine ? "Assigned to you." : row.status === "in_review" ? (orphaned ? "Its underwriter is gone." : "Assigned to another underwriter.") : ""
        }`.trim()}
        actions={
          <Link href="/queue" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
            ← Back to the queue
          </Link>
        }
      />

      <div className="grid gap-x-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Application" action={<ApplicationStatusBadge status={row.status} />}>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-application-fields>
              {rows.map(([term, value]) => (
                <div key={term} className="flex items-baseline justify-between gap-4 border-b border-border py-1">
                  <dt className="text-muted">{term}</dt>
                  <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {(row.status === "approved" || row.status === "declined") && (
              <div className="mt-4 space-y-1 text-sm" data-decision={row.status}>
                <p className="font-semibold">
                  {row.status === "approved" ? "Approved" : "Declined"} {formatDate(row.decidedAt)}
                </p>
                {row.decisionCodes && row.decisionCodes.length > 0 && (
                  <ul className="list-disc pl-5">
                    {row.decisionCodes.map((code) => (
                      <li key={code}>{DECISION_CODE_LABELS[code as DecisionCode] ?? code}</li>
                    ))}
                  </ul>
                )}
                {row.decisionNote && <p className="break-words text-muted">Decision note: {row.decisionNote}</p>}
              </div>
            )}
          </Panel>

          <Panel title="Documents" count={documents.length}>
            <p className="mb-3 rounded-card border border-border bg-building-soft px-3 py-2 text-sm text-building" data-malware-note>
              Files aren&apos;t scanned for malware. Open them with care. Each download is recorded in the audit log.
            </p>
            <ReviewDocuments documents={documents} />
          </Panel>

          <Panel title="Risk assessment" action={<DemoBadge label="Advisory" />}>
            <RiskPanel applicationId={row.id} applicationVersion={row.version} />
          </Panel>
        </div>

        <div>
          <Panel title="Actions">
            <ReviewActions id={row.id} version={row.version} status={row.status} mine={mine} orphaned={orphaned} />
          </Panel>

          <Panel title="Notes" count={notes.length}>
            {notes.length === 0 ? (
              <p className="mb-4 text-sm text-muted">No notes yet.</p>
            ) : (
              <ul className="mb-4 space-y-3" data-notes>
                {notes.map((n) => {
                  const full = "authorId" in n ? n : null;
                  const visibility = full?.visibility ?? "applicant";
                  const author = !full ? "Underwriter" : full.authorId === user.id ? "You" : full.authorId === row.applicantId ? "Applicant" : "Underwriter";
                  return (
                    <li key={n.id} className="rounded-card border border-border bg-background p-3" data-note-visibility={visibility}>
                      <p className="text-sm text-muted">
                        {author} · {visibility === "internal" ? "Internal" : "Visible to applicant"} · {formatDateTime(n.createdAt)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words">{n.body}</p>
                    </li>
                  );
                })}
              </ul>
            )}
            {["approved", "declined", "withdrawn"].includes(row.status) ? (
              <p className="text-sm text-muted">Notes are closed on a final application.</p>
            ) : (
              <AddNoteForm id={row.id} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
