import { describe, expect, it } from "vitest";
import { validateDecline, validateMessage } from "@/lib/decision-ui";

describe("validateDecline", () => {
  it("needs 1 to 4 known, distinct codes", () => {
    expect(validateDecline([], "")).toEqual({ ok: false, message: "Choose at least one reason code." });
    expect(validateDecline(["DTI_TOO_HIGH"], "")).toEqual({ ok: true, codes: ["DTI_TOO_HIGH"], note: "" });
    const five = ["DTI_TOO_HIGH", "INSUFFICIENT_INCOME", "INCOMPLETE_DOCUMENTATION", "SHORT_EMPLOYMENT", "UNVERIFIABLE_INFORMATION"];
    expect(validateDecline(five, "").ok).toBe(false);
    expect(validateDecline(five.slice(0, 4), "").ok).toBe(true);
    expect(validateDecline(["NOT_A_CODE"], "").ok).toBe(false);
  });
  it("collapses duplicates", () => {
    const result = validateDecline(["DTI_TOO_HIGH", "DTI_TOO_HIGH"], "");
    expect(result).toEqual({ ok: true, codes: ["DTI_TOO_HIGH"], note: "" });
  });
  it("makes OTHER need a note and caps the note", () => {
    expect(validateDecline(["OTHER"], "  ").ok).toBe(false);
    expect(validateDecline(["OTHER"], " Policy exception ")).toEqual({ ok: true, codes: ["OTHER"], note: "Policy exception" });
    expect(validateDecline(["DTI_TOO_HIGH"], "x".repeat(1001)).ok).toBe(false);
  });
});

describe("validateMessage", () => {
  it("needs text of 1 to 1,000 characters", () => {
    expect(validateMessage("   ").ok).toBe(false);
    expect(validateMessage(" Two pay stubs, please ")).toEqual({ ok: true, message: "Two pay stubs, please" });
    expect(validateMessage("x".repeat(1001)).ok).toBe(false);
  });
});
