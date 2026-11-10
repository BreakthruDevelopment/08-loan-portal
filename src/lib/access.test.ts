import { describe, expect, it } from "vitest";
import { canReadApplication, canReadNote, canWriteNote } from "@/lib/access";

const admin = { id: "admin", role: "admin" as const };
const ada = { id: "ada", role: "user" as const };
const ben = { id: "ben", role: "user" as const };
const quinn = { id: "quinn", role: "underwriter" as const };

describe("application access", () => {
  const sentAt = new Date("2026-01-02T00:00:00Z");
  const draft = { applicantId: "ada", status: "draft", submittedAt: null };
  const submitted = { applicantId: "ada", status: "submitted", submittedAt: sentAt };
  const withdrawnDraft = { applicantId: "ada", status: "withdrawn", submittedAt: null };

  it("gives an applicant their own rows only", () => {
    expect(canReadApplication(ada, draft)).toBe(true);
    expect(canReadApplication(ada, submitted)).toBe(true);
    expect(canReadApplication(ben, draft)).toBe(false);
    expect(canReadApplication(ben, submitted)).toBe(false);
  });

  it("hides drafts from underwriters and shows everything else", () => {
    expect(canReadApplication(quinn, draft)).toBe(false);
    expect(canReadApplication(quinn, submitted)).toBe(true);
    expect(canReadApplication(quinn, { ...submitted, status: "in_review" })).toBe(true);
    expect(canReadApplication(quinn, { ...submitted, status: "withdrawn" })).toBe(true);
    expect(canReadApplication(quinn, withdrawnDraft)).toBe(false);
    expect(canReadApplication(ada, withdrawnDraft)).toBe(true);
  });

  it("hides every application from an admin", () => {
    expect(canReadApplication(admin, draft)).toBe(false);
    expect(canReadApplication(admin, submitted)).toBe(false);
  });
});

describe("note access", () => {
  const sentAt = new Date("2026-01-02T00:00:00Z");
  const file = { applicantId: "ada", status: "in_review", submittedAt: sentAt };
  const asked = { ...file, status: "info_requested" };

  it("shows applicants only applicant-visible notes, and underwriters both kinds", () => {
    expect(canReadNote(ada, file, "applicant")).toBe(true);
    expect(canReadNote(ada, file, "internal")).toBe(false);
    expect(canReadNote(quinn, file, "internal")).toBe(true);
    expect(canReadNote(quinn, file, "applicant")).toBe(true);
    expect(canReadNote(ben, file, "applicant")).toBe(false);
    expect(canReadNote(admin, file, "applicant")).toBe(false);
  });

  it("lets the applicant write only while information is requested, and the underwriter write either kind until the file is final", () => {
    expect(canWriteNote(ada, asked, "applicant")).toBe(true);
    expect(canWriteNote(ada, asked, "internal")).toBe(false);
    expect(canWriteNote(ada, file, "applicant")).toBe(false);
    expect(canWriteNote(ada, { ...file, status: "submitted" }, "applicant")).toBe(false);
    expect(canWriteNote(quinn, file, "internal")).toBe(true);
    expect(canWriteNote(quinn, asked, "applicant")).toBe(true);
    for (const status of ["approved", "declined", "withdrawn"]) {
      expect(canWriteNote(quinn, { ...file, status }, "internal"), status).toBe(false);
      expect(canWriteNote(ada, { ...file, status }, "applicant"), status).toBe(false);
    }
    expect(canWriteNote(quinn, { applicantId: "ada", status: "draft", submittedAt: null }, "internal")).toBe(false);
  });
});
