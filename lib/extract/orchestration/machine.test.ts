import { describe, expect, it } from "vitest";

import {
  RUN_EVENTS,
  RUN_STATES,
  canTransition,
  isTerminal,
  legalEvents,
  transition,
  type RunEvent,
  type RunState,
} from "./machine";

describe("the table is total", () => {
  it("defines every state/event pair", () => {
    // The point of a total table: a pair nobody considered would throw or
    // return undefined here rather than quietly doing nothing at a call site.
    for (const state of RUN_STATES) {
      for (const event of RUN_EVENTS) {
        expect(typeof canTransition(state, event)).toBe("boolean");
      }
    }
    expect(RUN_STATES.length * RUN_EVENTS.length).toBe(25);
  });

  it("mirrors the extraction_run_status enum in migration 0005", () => {
    expect([...RUN_STATES].sort()).toEqual([
      "exception",
      "failed",
      "pending",
      "running",
      "succeeded",
    ]);
  });
});

describe("the legal lifecycle", () => {
  it.each([
    ["pending", "claim", "running"],
    ["pending", "fail", "failed"],
    ["running", "succeed", "succeeded"],
    ["running", "raise_exception", "exception"],
    ["running", "fail", "failed"],
    ["running", "release", "pending"],
  ] as const)("%s + %s -> %s", (from, event, to) => {
    const r = transition(from, event);
    expect(r.ok && r.value).toBe(to);
  });

  it("lets a pending run fail before anyone claims it", () => {
    // An unreadable document or a refused cost ceiling ends a run that no
    // worker ever picked up.
    expect(canTransition("pending", "fail")).toBe(true);
  });

  it("returns a cancelled run to the pool rather than failing it", () => {
    const r = transition("running", "release");
    expect(r.ok && r.value).toBe("pending");
  });
});

describe("illegal moves fail immediately", () => {
  it.each([
    ["pending", "succeed"],
    ["pending", "release"],
    ["pending", "raise_exception"],
    ["running", "claim"],
  ] as const)("refuses %s + %s", (from, event) => {
    const r = transition(from, event);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("PROCESSING_FAILED_PERMANENT");
      expect(r.failure.detail).toContain("illegal transition");
    }
  });

  it("refuses a second claim, which is the double-processing guard", () => {
    expect(canTransition("running", "claim")).toBe(false);
  });

  it("names the state and event without inventing a recovery", () => {
    const r = transition("succeeded", "claim");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.detail).toContain("claim");
      expect(r.failure.detail).toContain("succeeded");
    }
  });
});

describe("terminal states", () => {
  it.each(["succeeded", "exception", "failed"] as const)(
    "%s admits no further event",
    (state) => {
      expect(isTerminal(state)).toBe(true);
      expect(legalEvents(state)).toEqual([]);
      for (const event of RUN_EVENTS) {
        expect(transition(state, event).ok).toBe(false);
      }
    },
  );

  it.each(["pending", "running"] as const)("%s is not terminal", (state) => {
    expect(isTerminal(state)).toBe(false);
    expect(legalEvents(state).length).toBeGreaterThan(0);
  });

  it("never revives a failed run", () => {
    // A retry inserts a NEW run at the next attempt so the history of what was
    // tried survives; resurrecting the row would erase it.
    expect(legalEvents("failed")).toEqual([]);
  });
});

describe("transition is pure", () => {
  it("gives the same answer every time", () => {
    const answers = Array.from({ length: 50 }, () => {
      const r = transition("running", "succeed");
      return r.ok ? r.value : "FAILED";
    });
    expect(new Set(answers)).toEqual(new Set(["succeeded"]));
  });

  it("exposes no way to mutate the table", () => {
    const before = RUN_STATES.map((s: RunState) => legalEvents(s).join(","));
    // legalEvents returns a fresh array; mutating it must not affect the machine.
    (legalEvents("running") as RunEvent[]).length = 0;
    const after = RUN_STATES.map((s: RunState) => legalEvents(s).join(","));
    expect(after).toEqual(before);
  });
});
