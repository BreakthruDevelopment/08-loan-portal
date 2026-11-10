import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_GENESIS, assertSafeDetail, auditHash, canonicalAuditPayload } from "@/lib/audit";
import { BadRequestError } from "@/lib/errors";

describe("audit hash", () => {
  it("hashes the canonical payload with an empty previous hash for genesis", () => {
    const payload = canonicalAuditPayload(AUDIT_GENESIS);
    expect(payload).toBe(
      '{"id":1,"at":"2026-01-01T00:00:00.000Z","actor_id":"system","actor_role":"system","action":"audit.genesis","application_id":null,"document_id":null,"detail":{}}',
    );
    const hash = auditHash(null, payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(auditHash("aa", payload)).not.toBe(hash);
  });

  it("keeps the genesis hash and the append-only triggers in the migration", () => {
    const sql = readdirSync("drizzle")
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(`drizzle/${name}`, "utf8"))
      .join("\n");
    expect(sql).toContain(auditHash(null, canonicalAuditPayload(AUDIT_GENESIS)));
    expect(sql).toContain("audit_event_no_update_delete");
    expect(sql).toContain("audit_event_no_truncate");
    expect(sql).toContain("audit_event is append-only");
  });
});

describe("assertSafeDetail", () => {
  it("allows field names, statuses, and reason codes", () => {
    expect(assertSafeDetail({ fields: ["purpose"], from: "draft", to: "submitted", codes: ["DTI_TOO_HIGH"] })).toEqual({
      fields: ["purpose"],
      from: "draft",
      to: "submitted",
      codes: ["DTI_TOO_HIGH"],
    });
  });

  it("allows a list of every application field name, but not an unbounded list", () => {
    const names = ["amountCents", "termMonths", "purpose", "employmentStatus", "employerName", "monthsEmployed", "annualIncomeCents", "monthlyHousingCents", "monthlyDebtCents", "creditBand"];
    expect(assertSafeDetail({ fields: names })).toEqual({ fields: names });
    expect(() => assertSafeDetail({ fields: Array.from({ length: 17 }, (_, i) => `f${i}`) })).toThrow(BadRequestError);
  });

  it("refuses amounts, names, filenames, and note text", () => {
    for (const detail of [
      { amountCents: 100 },
      { note: "please send stubs" },
      { message: "hello" },
      { displayName: "pay.pdf" },
      { employerName: "Northwind" },
      { email: "ada@example.test" },
      { nested: { a: 1 } },
      { fields: ["x".repeat(81)] },
    ]) {
      expect(() => assertSafeDetail(detail)).toThrow(BadRequestError);
    }
  });
});
