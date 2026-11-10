import { statusTimeline } from "@/lib/ui-labels";
import type { ApplicationStatus } from "@/lib/loan";

/** The applicant's progress. Names no reviewer. */
export function StatusTimeline({ status }: { status: ApplicationStatus }) {
  const steps = statusTimeline(status);
  return (
    <ol aria-label="Application progress" className="flex flex-wrap gap-2" data-timeline>
      {steps.map((step) => (
        <li
          key={step.key}
          data-timeline-step={step.key}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
          className={`inline-flex min-h-9 items-center gap-2 rounded-card border px-3 text-sm font-medium ${
            step.state === "current"
              ? "border-accent bg-accent-soft text-accent"
              : step.state === "done"
                ? "border-border bg-surface text-foreground"
                : "border-border bg-background text-muted"
          }`}
        >
          <span aria-hidden>{step.state === "done" ? "✓" : step.state === "current" ? "●" : "○"}</span>
          {step.label}
          <span className="sr-only">{step.state === "done" ? " (done)" : step.state === "current" ? " (current)" : " (not yet)"}</span>
        </li>
      ))}
    </ol>
  );
}
