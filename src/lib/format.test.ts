import { describe, expect, it } from "vitest";
import {
  centsToInput,
  formatBytes,
  formatCents,
  formatDate,
  formatDateTime,
  parseDollarsToCents,
  parseWholeNumber,
  shortId,
} from "@/lib/format";

describe("formatCents", () => {
  it("formats integer cents without going through floats", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(150000)).toBe("$1,500.00");
    expect(formatCents(5_000_000)).toBe("$50,000.00");
    expect(formatCents(1_999_999_999)).toBe("$19,999,999.99");
    expect(formatCents(-250)).toBe("-$2.50");
  });
  it("shows a dash for missing values", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
    expect(formatCents(Number.NaN)).toBe("—");
  });
});

describe("parseDollarsToCents", () => {
  it("parses plain, grouped and prefixed amounts exactly", () => {
    expect(parseDollarsToCents("1500")).toEqual({ ok: true, cents: 150000 });
    expect(parseDollarsToCents("1,500")).toEqual({ ok: true, cents: 150000 });
    expect(parseDollarsToCents(" $1,500.5 ")).toEqual({ ok: true, cents: 150050 });
    expect(parseDollarsToCents("0.07")).toEqual({ ok: true, cents: 7 });
    // 19.99 * 100 is 1998.9999999999998 as a float; string arithmetic gets it right.
    expect(parseDollarsToCents("19.99")).toEqual({ ok: true, cents: 1999 });
    expect(parseDollarsToCents("1.15")).toEqual({ ok: true, cents: 115 });
  });
  it("treats empty as not entered", () => {
    expect(parseDollarsToCents("")).toEqual({ ok: true, cents: null });
    expect(parseDollarsToCents("   ")).toEqual({ ok: true, cents: null });
  });
  it("rejects anything that isn't money", () => {
    for (const bad of ["abc", "1.234", "-5", "1,50", "1e3", "12,34,567", "$", "1.", ".5", "9".repeat(20)]) {
      expect(parseDollarsToCents(bad), bad).toEqual({ ok: false });
    }
  });
});

describe("centsToInput", () => {
  it("round-trips through parseDollarsToCents", () => {
    for (const cents of [0, 7, 100, 150000, 150050, 5_000_000]) {
      expect(parseDollarsToCents(centsToInput(cents))).toEqual({ ok: true, cents });
    }
    expect(centsToInput(null)).toBe("");
  });
});

describe("parseWholeNumber", () => {
  it("accepts digits and empty, rejects the rest", () => {
    expect(parseWholeNumber("24")).toEqual({ ok: true, value: 24 });
    expect(parseWholeNumber("")).toEqual({ ok: true, value: null });
    expect(parseWholeNumber("2.5")).toEqual({ ok: false });
    expect(parseWholeNumber("-1")).toEqual({ ok: false });
    expect(parseWholeNumber("1234567890")).toEqual({ ok: false });
  });
});

describe("dates, sizes, ids", () => {
  it("formats in UTC", () => {
    expect(formatDate(new Date("2026-11-10T23:59:00Z"))).toBe("2026-11-10");
    expect(formatDateTime("2026-11-10T16:28:30Z")).toBe("2026-11-10 16:28 UTC");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  it("shortens ids", () => {
    expect(shortId("16f07863-ca5c-4c78-96d3-201e45114714")).toBe("16f07863");
    expect(shortId(null)).toBe("—");
  });
});
