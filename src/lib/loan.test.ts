import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import { ForbiddenError } from "@/lib/auth/rbac";
import { type DecisionCode, planTransition, type TransitionPlanInput } from "@/lib/loan";

const ready: TransitionPlanInput = {
  from: "draft",
  to: "submitted",
  role: "user",
  isOwner: true,
  isAssigned: false,
  fieldsComplete: true,
  hasIdDocument: true,
  hasIncomeDocument: true,
  hasReplyOrDocument: false,
  message: "",
  codes: [],
  note: "",
};

const plan = (over: Partial<TransitionPlanInput>) => planTransition({ ...ready, ...over });

describe("planTransition", () => {
  it("submits a complete draft for its applicant", () => {
    expect(plan({}).kind).toBe("submit");
  });

  it("refuses a submit that is missing fields or documents", () => {
    expect(() => plan({ fieldsComplete: false })).toThrow(ConflictError);
    expect(() => plan({ hasIdDocument: false })).toThrow(ConflictError);
    expect(() => plan({ hasIncomeDocument: false })).toThrow(ConflictError);
  });

  it("re-checks fields and documents when the applicant resubmits from info_requested", () => {
    const resubmit = { from: "info_requested" as const, hasReplyOrDocument: true };
    expect(plan(resubmit).kind).toBe("resubmit");
    expect(() => plan({ ...resubmit, fieldsComplete: false })).toThrow(ConflictError);
    expect(() => plan({ ...resubmit, hasIdDocument: false })).toThrow(ConflictError);
    expect(() => plan({ ...resubmit, hasIncomeDocument: false })).toThrow(ConflictError);
  });

  it("lets any underwriter release an in_review file that has no assignee, and only then", () => {
    const stuck = { from: "in_review" as const, to: "submitted" as const, role: "underwriter" as const, isOwner: false };
    expect(plan({ ...stuck, isUnassigned: true }).kind).toBe("release");
    expect(() => plan({ ...stuck, isUnassigned: false })).toThrow(ForbiddenError);
    expect(() => plan({ ...stuck, isUnassigned: true, role: "user" })).toThrow(ForbiddenError);
  });

  it("lets any underwriter claim a submitted file", () => {
    expect(plan({ from: "submitted", to: "in_review", role: "underwriter", isOwner: false }).kind).toBe("claim");
    expect(() => plan({ from: "submitted", to: "in_review" })).toThrow(ForbiddenError);
  });

  it("lets only the assigned underwriter release, request information, or decide", () => {
    expect(plan({ from: "in_review", to: "submitted", role: "underwriter", isAssigned: true }).kind).toBe("release");
    expect(() => plan({ from: "in_review", to: "submitted", role: "underwriter", isAssigned: false })).toThrow(ForbiddenError);

    expect(
      plan({ from: "in_review", to: "info_requested", role: "underwriter", isAssigned: true, message: "Need a pay stub" }).kind,
    ).toBe("request_info");
    expect(() =>
      plan({ from: "in_review", to: "info_requested", role: "underwriter", isAssigned: true, message: "  " }),
    ).toThrow(ConflictError);
    expect(() => plan({ from: "in_review", to: "info_requested", role: "underwriter", isAssigned: false, message: "x" })).toThrow(
      ForbiddenError,
    );

    expect(plan({ from: "in_review", to: "approved", role: "underwriter", isAssigned: true }).kind).toBe("approve");
    expect(() => plan({ from: "in_review", to: "approved", role: "underwriter", isAssigned: true, codes: ["DTI_TOO_HIGH"] })).toThrow(
      ConflictError,
    );
    expect(() => plan({ from: "in_review", to: "approved", role: "underwriter", isAssigned: false })).toThrow(ForbiddenError);
  });

  it("declines only with 1 to 4 unique codes, and OTHER needs a note", () => {
    const codes: DecisionCode[] = ["DTI_TOO_HIGH"];
    expect(plan({ from: "in_review", to: "declined", role: "underwriter", isAssigned: true, codes }).kind).toBe("decline");
    expect(() => plan({ from: "in_review", to: "declined", role: "underwriter", isAssigned: true, codes: [] })).toThrow(ConflictError);
    expect(() =>
      plan({
        from: "in_review",
        to: "declined",
        role: "underwriter",
        isAssigned: true,
        codes: ["DTI_TOO_HIGH", "DTI_TOO_HIGH"],
      }),
    ).toThrow(ConflictError);
    expect(() =>
      plan({
        from: "in_review",
        to: "declined",
        role: "underwriter",
        isAssigned: true,
        codes: ["OTHER"],
      }),
    ).toThrow(ConflictError);
    expect(
      plan({ from: "in_review", to: "declined", role: "underwriter", isAssigned: true, codes: ["OTHER"], note: "See the file" }).kind,
    ).toBe("decline");
  });

  it("sends an information request back when the applicant replies or has already replied", () => {
    expect(plan({ from: "info_requested", to: "submitted", message: "Uploaded the stub" }).kind).toBe("resubmit");
    expect(plan({ from: "info_requested", to: "submitted", hasReplyOrDocument: true }).kind).toBe("resubmit");
    expect(() => plan({ from: "info_requested", to: "submitted" })).toThrow(ConflictError);
    expect(() => plan({ from: "info_requested", to: "submitted", role: "underwriter", isOwner: false, message: "x" })).toThrow(
      ForbiddenError,
    );
  });

  it("lets the applicant withdraw any non-final file and nobody else", () => {
    for (const from of ["draft", "submitted", "in_review", "info_requested"] as const) {
      expect(plan({ from, to: "withdrawn" }).kind).toBe("withdraw");
    }
    expect(() => plan({ from: "submitted", to: "withdrawn", role: "underwriter", isOwner: false })).toThrow(ForbiddenError);
  });

  it("keeps a final file immutable and refuses jumps that are not in the table", () => {
    expect(() => plan({ from: "approved", to: "withdrawn" })).toThrow(ConflictError);
    expect(() => plan({ from: "declined", to: "submitted" })).toThrow(ConflictError);
    expect(() => plan({ from: "withdrawn", to: "submitted" })).toThrow(ConflictError);
    expect(() => plan({ from: "draft", to: "approved" })).toThrow(ConflictError);
    expect(() => plan({ from: "submitted", to: "approved", role: "underwriter", isAssigned: true })).toThrow(ConflictError);
  });
});
