"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { FailureNote } from "@/components/feedback";
import { inputClass } from "@/components/ui/styles";
import { type Failure, describeFailure } from "@/lib/api-errors";
import { authClient } from "@/lib/auth/client";
import { ROLES, type Role } from "@/lib/auth/rbac";

const ROLE_LABELS: Record<Role, string> = { user: "Applicant", underwriter: "Underwriter", admin: "Admin" };

/**
 * Changes a role through Better Auth's set-role endpoint only, which is the one path that writes the `role.changed`
 * audit row. The admin's own row is locked so the last admin can't remove themselves.
 */
export function RoleSelect({ userId, name, role, self }: { userId: string; name: string; role: Role; self: boolean }) {
  const router = useRouter();
  const id = useId();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <div className="space-y-1" data-role-cell={userId}>
      <label htmlFor={id} className="sr-only">
        Role for {name}
      </label>
      <select
        id={id}
        className={inputClass}
        defaultValue={role}
        disabled={pending || self}
        aria-describedby={self ? `${id}-self` : undefined}
        data-role-select={userId}
        onChange={(event) => {
          const next = event.target.value as Role;
          setFailure(null);
          setSaved(false);
          start(async () => {
            const result = await authClient.admin.setRole({ userId, role: next });
            if (result.error) {
              event.target.value = role;
              setFailure(describeFailure({ status: result.error.status ?? 500, message: result.error.message }));
              return;
            }
            setSaved(true);
            router.refresh();
          });
        }}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      {self && (
        <p id={`${id}-self`} className="text-sm text-muted">
          Your own role can&apos;t be changed here.
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-success">
          Role saved.
        </p>
      )}
      <FailureNote failure={failure} />
    </div>
  );
}
