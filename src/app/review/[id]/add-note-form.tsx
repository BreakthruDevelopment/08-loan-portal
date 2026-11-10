"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { Field } from "@/components/field";
import { buttonPrimary, inputClass } from "@/components/ui/styles";
import type { Failure } from "@/lib/api-errors";
import { addReviewNoteAction } from "../actions";

export function AddNoteForm({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"internal" | "applicant">("internal");

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = body.trim();
        setFailure(null);
        if (trimmed === "") return setProblem("Write a note first.");
        if (trimmed.length > 2000) return setProblem("A note can be up to 2,000 characters.");
        setProblem(undefined);
        start(async () => {
          const result = await addReviewNoteAction(id, { body: trimmed, visibility });
          if (!result.ok) return setFailure(result);
          setBody("");
          router.refresh();
        });
      }}
    >
      <Field id="note-body" label="Add a note" error={problem}>
        {(p) => <textarea rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} className={inputClass} {...p} />}
      </Field>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Who can read it</legend>
        {(
          [
            ["internal", "Internal: underwriters only"],
            ["applicant", "Visible to the applicant"],
          ] as const
        ).map(([value, text]) => (
          <label key={value} className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} className="size-5 accent-accent" />
            {text}
          </label>
        ))}
      </fieldset>
      <FailureNote failure={failure} onRefresh={() => router.refresh()} />
      <button type="submit" className={buttonPrimary} disabled={pending}>
        {pending ? "Saving…" : "Add note"}
      </button>
    </form>
  );
}
