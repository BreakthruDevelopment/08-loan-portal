import { ServiceBusyError, TooManyRequestsError } from "@/lib/errors";

/**
 * In-flight upload limits, checked before the body is read. A 5 MB upload is copied several times on its way to
 * Postgres, and the Oracle VM has 1 GB shared with the database, so only a few may be in flight: 1 per user and
 * 2 per process. State is per process (module scope), which is the unit that has the memory.
 */
export const MAX_UPLOADS_PER_PROCESS = 2;
export const MAX_UPLOADS_PER_USER = 1;

let active = 0;
const perUser = new Map<string, number>();

/** Take a slot or throw 429 (this user already has one) or 503 (the process is full). Call `release` in `finally`. */
export function acquireUploadSlot(userId: string): () => void {
  if ((perUser.get(userId) ?? 0) >= MAX_UPLOADS_PER_USER) {
    throw new TooManyRequestsError("Finish your current upload first.", 2);
  }
  if (active >= MAX_UPLOADS_PER_PROCESS) throw new ServiceBusyError("Too many uploads are in progress. Try again shortly.", 5);
  active += 1;
  perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    const left = (perUser.get(userId) ?? 1) - 1;
    if (left <= 0) perUser.delete(userId);
    else perUser.set(userId, left);
  };
}

/** For tests. */
export function uploadSlotsInUse(): number {
  return active;
}
