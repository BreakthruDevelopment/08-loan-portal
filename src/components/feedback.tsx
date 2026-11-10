"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { Failure } from "@/lib/api-errors";
import { buttonSecondary } from "@/components/ui/styles";

/**
 * An error announced to screen readers. When the failure is a stale update it offers the refresh the page needs
 * (the caller re-fetches the server data), so a 409 never leaves the user stuck.
 */
export function FailureNote({
  failure,
  onRefresh,
  refreshing = false,
  id,
}: {
  failure: Pick<Failure, "message" | "stale"> | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  id?: string;
}) {
  if (!failure) return null;
  return (
    <div role="alert" id={id} className="space-y-2 rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm text-blocked">
      <p className="font-medium">{failure.message}</p>
      {failure.stale && onRefresh && (
        <button type="button" onClick={onRefresh} disabled={refreshing} className={buttonSecondary}>
          {refreshing ? "Loading…" : "Load the latest version"}
        </button>
      )}
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

/**
 * A modal built on the native <dialog>: focus is trapped and Escape closes it. `open` is controlled by the parent.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground backdrop:bg-foreground/40"
    >
      {open && (
        <div className="space-y-4">
          <h2 id={titleId} className="font-display text-2xl font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{children}</div>;
}

