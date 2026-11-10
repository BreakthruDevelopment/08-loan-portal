import { describe, expect, it } from "vitest";
import { describeFailure, parseRetryAfter, precheckUpload } from "@/lib/api-errors";

describe("parseRetryAfter", () => {
  it("reads seconds and dates", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(1);
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(parseRetryAfter("Tue, 10 Nov 2026 12:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("Tue, 10 Nov 2026 11:00:00 GMT", now)).toBe(1);
  });
  it("returns null for nothing or nonsense", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("describeFailure", () => {
  it("says what to do for each upload status", () => {
    expect(describeFailure({ status: 413, message: "Body too large (limit 5767168 bytes)" }).message).toBe(
      "That file is too big. Files can be up to 5 MB.",
    );
    expect(describeFailure({ status: 411 }).message).toContain("file size");
    expect(describeFailure({ status: 408, message: "The upload took too long." }).message).toBe(
      "The upload took too long. Try again on a faster connection.",
    );
    expect(describeFailure({ status: 0 }).message).toContain("Couldn't reach the server");
  });
  it("keeps the server's specific text for type and content errors", () => {
    expect(describeFailure({ status: 415, message: "The file extension doesn't match its contents." }).message).toBe(
      "The file extension doesn't match its contents. Use a PDF, PNG or JPEG.",
    );
    expect(describeFailure({ status: 415, message: "Upload a PDF, PNG, or JPEG." }).message).toContain("PDF, PNG");
    expect(describeFailure({ status: 422, message: "PDFs with scripts, attachments or passwords aren't accepted." }).message).toBe(
      "PDFs with scripts, attachments or passwords aren't accepted.",
    );
  });
  it("adds the wait to a 429 and a 503", () => {
    const limited = describeFailure({ status: 429, message: "Finish your current upload first.", retryAfterSeconds: 2 });
    expect(limited.message).toBe("Finish your current upload first. Try again in 2 seconds.");
    expect(limited.retryAfterSeconds).toBe(2);
    expect(describeFailure({ status: 429, message: "Too many.", retryAfterSeconds: 1 }).message).toBe("Too many. Try again in 1 second.");
    expect(describeFailure({ status: 429, message: "Slow down", retryAfterSeconds: 600 }).message).toBe(
      "Slow down. Try again in about 10 minutes.",
    );
    expect(describeFailure({ status: 429 }).message).toBe("Too many requests.");
    expect(describeFailure({ status: 503, message: "Busy.", retryAfterSeconds: 5 }).message).toContain("5 seconds");
  });
  it("marks a stale update so the page can offer a refresh", () => {
    const stale = describeFailure({ status: 409, message: "This application was updated. Reload and try again." });
    expect(stale.stale).toBe(true);
    expect(describeFailure({ status: 409, message: "That file is already on this application." }).stale).toBe(false);
    expect(describeFailure({ status: 409, message: "This application changed while the summary was being written. Generate it again." }).stale).toBe(true);
  });
  it("never shows a stack or internals for a 500", () => {
    expect(describeFailure({ status: 500, message: "TypeError: x is undefined at foo.ts:1" }).message).toBe(
      "Something went wrong on our side. Try again in a moment.",
    );
  });
  it("replaces the zod catch-all", () => {
    expect(describeFailure({ status: 400, message: "Invalid input" }).message).toContain("aren't valid");
    expect(describeFailure({ status: 400, message: "Choose a document type." }).message).toBe("Choose a document type.");
  });
});

describe("precheckUpload", () => {
  it("refuses empty and oversize files only", () => {
    expect(precheckUpload({ name: "a.pdf", size: 0 })).toBe("That file is empty.");
    expect(precheckUpload({ name: "a.pdf", size: 5 * 1024 * 1024 + 1 })).toContain("too big");
    expect(precheckUpload({ name: "a.pdf", size: 5 * 1024 * 1024 })).toBeNull();
    expect(precheckUpload({ name: "a.exe", size: 10 })).toBeNull();
  });
});
