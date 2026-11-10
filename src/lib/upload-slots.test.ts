import { describe, expect, it } from "vitest";
import { acquireUploadSlot, uploadSlotsInUse } from "@/lib/upload-slots";

describe("upload slots", () => {
  it("allows one per user and two per process, and release frees them (once)", () => {
    const a = acquireUploadSlot("a");
    expect(() => acquireUploadSlot("a")).toThrowError(expect.objectContaining({ status: 429, retryAfterSeconds: 2 }));
    const b = acquireUploadSlot("b");
    expect(() => acquireUploadSlot("c")).toThrowError(expect.objectContaining({ status: 503, retryAfterSeconds: 5 }));
    expect(uploadSlotsInUse()).toBe(2);
    a();
    a(); // a second release must not free someone else's slot
    expect(uploadSlotsInUse()).toBe(1);
    const c = acquireUploadSlot("c");
    expect(() => acquireUploadSlot("d")).toThrowError(expect.objectContaining({ status: 503 }));
    b();
    c();
    expect(uploadSlotsInUse()).toBe(0);
  });
});
