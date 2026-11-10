import { describe, expect, it } from "vitest";
import { canReadApplication, canReadNote, canWriteNote } from "@/lib/access";

const admin = { id: "admin", role: "admin" as const };
const ada = { id: "ada", role: "user" as const };
const ben = { id: "ben", role: "user" as const };
const quinn = { id: "quinn", role: "underwriter" as const };

describe("application access", () => {
  const draft = { applicantId: "ada", status: "draft" };
  const submitted = { applicantId: "ada", status: "submitted" };

  it("gives an applicant their own rows only", () => {
    expect(canReadApplication(ada, draft)).toBe(true);
    expect(canReadApplication(ada, submitted)).toBe(true);
    expect(canReadApplication(ben, draft)).toBe(false);
    expect(canReadApplication(ben, submitted)).toBe(false);
  });

  it("hides drafts from underwriters and shows everything else", () => {
    expect(canReadApplication(quinn, draft)).toBe(false);
    expect(canReadApplication(quinn, submitted)).toBe(true);
    expect(canReadApplication(quinn, { applicantId: "ada", status: "in_review" })).toBe(true);
  });

  it("hides every application from an admin", () => {
    expect(canReadApplication(admin, draft)).toBe(false);
    expect(canReadApplication(admin, submitted)).toBe(false);
  });
});

describe("note access", () => {
  const file = { applicantId: "ada", status: "in_review" };

  it("shows applicants only applicant-visible notes, and underwriters both kinds", () => {
    expect(canReadNote(ada, file, "applicant")).toBe(true);
    expect(canReadNote(ada, file, "internal")).toBe(false);
    expect(canReadNote(quinn, file, "internal")).toBe(true);
    expect(canReadNote(quinn, file, "applicant")).toBe(true);
    expect(canReadNote(ben, file, "applicant")).toBe(false);
    expect(canReadNote(admin, file, "applicant")).toBe(false);
  });

  it("lets the applicant write an applicant note and the underwriter write either", () => {
    expect(canWriteNote(ada, file, "applicant")).toBe(true);
    expect(canWriteNote(ada, file, "internal")).toBe(false);
    expect(canWriteNote(quinn, file, "internal")).toBe(true);
    expect(canWriteNote(quinn, { applicantId: "ada", status: "draft" }, "internal")).toBe(false);
  });
});
