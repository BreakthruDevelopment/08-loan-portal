import Link from "next/link";
import { DemoBadge, PageIntro, Panel, StatusBadge, buttonPrimary, buttonSecondary } from "@/components/ui";

const features = [
  { title: "Applicants", body: "Start a personal-loan application, save a draft, and send it in when the file is complete." },
  { title: "Underwriters", body: "A queue of submitted applications. Drafts stay private to the applicant." },
  { title: "Admins", body: "Counts, storage, and the audit log. Admins never open an application." },
  { title: "An audit trail", body: "Decisions are appended to a hash chain. A later edit shows up when the chain is checked." },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Loan portal"
        title="A borrower file and an underwriting desk."
        description="Applicants keep their own drafts. Underwriters see a file only after it is submitted. Admins see counts and the audit log."
        actions={
          <>
            <Link href="/sign-in" className={buttonPrimary}>
              Get started
            </Link>
            <Link href="/api/health" className={buttonSecondary}>
              Health check
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.title} title={f.title}>
            <p className="text-muted">{f.body}</p>
          </Panel>
        ))}
      </div>
      <Panel title="Status labels" action={<DemoBadge />}>
        <p className="mb-3 text-muted">
          The shared badges used across the portfolio. Not started is neutral, never an error.
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="live" />
          <StatusBadge status="building" />
          <StatusBadge status="blocked" />
          <StatusBadge status="not-started" />
        </div>
      </Panel>
    </>
  );
}
