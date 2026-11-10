import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, DECISION_CODES, DOCUMENT_KINDS } from "@/lib/loan";
import {
  DECISION_CODE_LABELS,
  DOCUMENT_KIND_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  label,
  statusTimeline,
} from "@/lib/ui-labels";

describe("labels", () => {
  it("cover every status, decision code and document kind", () => {
    for (const status of APPLICATION_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_TONES[status]).toBeTruthy();
    }
    for (const code of DECISION_CODES) expect(DECISION_CODE_LABELS[code]).toBeTruthy();
    for (const kind of DOCUMENT_KINDS) expect(DOCUMENT_KIND_LABELS[kind]).toBeTruthy();
  });
  it("falls back to a readable value", () => {
    expect(label({}, "some_value")).toBe("some value");
    expect(label({}, null)).toBe("—");
  });
});

describe("statusTimeline", () => {
  const states = (status: Parameters<typeof statusTimeline>[0]) => statusTimeline(status).map((s) => `${s.label}:${s.state}`);
  it("marks progress", () => {
    expect(states("draft")).toEqual(["Draft:current", "Submitted:todo", "In review:todo", "Decision:todo"]);
    expect(states("in_review")).toEqual(["Draft:done", "Submitted:done", "In review:current", "Decision:todo"]);
  });
  it("shows an information request as the current step", () => {
    expect(states("info_requested")[2]).toBe("Information requested:current");
  });
  it("ends on the decision", () => {
    expect(states("approved")[3]).toBe("Approved:current");
    expect(states("declined")[3]).toBe("Declined:current");
  });
  it("stops a withdrawn file where it was", () => {
    expect(states("withdrawn")).toEqual(["Draft:done", "Withdrawn:current"]);
  });
});
