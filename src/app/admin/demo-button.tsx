"use client";

import { useActionState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { type DemoActionState, loadDemoAction } from "./actions";

export function DemoButton() {
  const [state, action, pending] = useActionState<DemoActionState, FormData>(loadDemoAction, {});
  return (
    <form action={action} className="space-y-3">
      <button type="submit" className={buttonPrimary} disabled={pending}>
        {pending ? "Loading demo…" : "Load demo workspace"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      {state.ok && <p className="text-sm text-muted">Demo workspace loaded. The password is not shown.</p>}
    </form>
  );
}
