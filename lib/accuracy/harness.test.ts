import { describe, expect, it } from "vitest";

import { sen } from "@/lib/domain/money";
import type { StatementDraft } from "@/lib/domain/statement";
import { buildStatementDraft, corruptLineAmount } from "@/lib/domain/testing";

import {
  aggregate,
  compareStatements,
  formatAggregate,
  ratio,
  type DocumentAccuracy,
} from "./harness";

const OPTIONS = {
  documentId: "00000000-0000-7000-8000-0000000000d1",
  producerId: "synthetic-v1",
  runId: "00000000-0000-7000-8000-0000000000r1",
  measuredAt: "2026-07-30",
  expectedReconciled: true,
  actualReconciled: true,
};

function truth(overrides = {}): StatementDraft {
  return buildStatementDraft({
    documentId: OPTIONS.documentId,
    lineCount: 8,
    withRunningBalances: true,
    ...overrides,
  });
}

function compare(actual: StatementDraft, expected = truth(), options = {}) {
  return compareStatements(expected, actual, { ...OPTIONS, ...options });
}

// ---------------------------------------------------------------------------
// A perfect extraction
// ---------------------------------------------------------------------------

describe("a perfect extraction", () => {
  it("scores every field and every line exact", () => {
    const r = compare(truth());

    expect(r.header.fields).toEqual({ exact: 7, total: 7 });
    expect(r.lines.exactLines).toEqual({ exact: 8, total: 8 });
    expect(r.lines.date).toEqual({ exact: 8, total: 8 });
    expect(r.lines.debit).toEqual({ exact: 8, total: 8 });
    expect(r.lines.credit).toEqual({ exact: 8, total: 8 });
    expect(r.lines.mismatchedPositions).toEqual([]);
    expect(r.reconciliation.agreed).toBe(true);
  });

  it("carries provenance on every result", () => {
    // Non-negotiable 7: an undated figure is a bug.
    const r = compare(truth());
    expect(r.documentId).toBe(OPTIONS.documentId);
    expect(r.producerId).toBe("synthetic-v1");
    expect(r.runId).toBe(OPTIONS.runId);
    expect(r.measuredAt).toBe("2026-07-30");
  });
});

// ---------------------------------------------------------------------------
// Single-field corruptions isolate a single field class
// ---------------------------------------------------------------------------

describe("a corruption is attributed to exactly one field class", () => {
  it("isolates an amount error", () => {
    const r = compare(corruptLineAmount(truth(), 3, 1n));

    expect(r.lines.exactLines).toEqual({ exact: 7, total: 8 });
    expect(r.lines.mismatchedPositions).toEqual([3]);
    expect(r.lines.date).toEqual({ exact: 8, total: 8 });
    expect(r.lines.description).toEqual({ exact: 8, total: 8 });
    // Exactly one of debit/credit moved.
    expect(r.lines.debit.exact + r.lines.credit.exact).toBe(15);
  });

  it("isolates a date error", () => {
    const base = truth();
    const first = base.lines[0];
    if (!first) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, date: "2026-07-01" as typeof first.date };

    const r = compare({ ...base, lines });
    expect(r.lines.date).toEqual({ exact: 7, total: 8 });
    expect(r.lines.description).toEqual({ exact: 8, total: 8 });
    expect(r.lines.exactLines.exact).toBe(7);
  });

  it("isolates a description error, and reports the normalised variant beside it", () => {
    const base = truth();
    const first = base.lines[0];
    if (!first) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    // Whitespace and case only: strict fails, normalised passes.
    lines[0] = { ...first, description: `  ${first.description.toLowerCase()}  ` };

    const r = compare({ ...base, lines });
    expect(r.lines.description).toEqual({ exact: 7, total: 8 });
    expect(r.lines.descriptionNormalised).toEqual({ exact: 8, total: 8 });
  });

  it("isolates a header error", () => {
    const r = compare({ ...truth(), currency: "SGD" });
    expect(r.header.currency).toBe(false);
    expect(r.header.accountReference).toBe(true);
    expect(r.header.fields).toEqual({ exact: 6, total: 7 });
    expect(r.lines.exactLines).toEqual({ exact: 8, total: 8 });
  });

  it("treats an absent running balance as different from a stated one", () => {
    // Absent is not zero, and it is not equal to a value either.
    const expected = truth();
    const actual = buildStatementDraft({
      documentId: OPTIONS.documentId,
      lineCount: 8,
      withRunningBalances: false,
    });
    const r = compare(actual, expected);
    expect(r.lines.runningBalance.exact).toBe(0);
    expect(r.lines.runningBalance.total).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Missing and extra lines
// ---------------------------------------------------------------------------

describe("line-count differences", () => {
  it("counts missing lines and compares only the positions that exist", () => {
    const expected = truth();
    const actual = { ...expected, lines: expected.lines.slice(0, 5) };
    const r = compare(actual, expected);

    expect(r.lines.expectedCount).toBe(8);
    expect(r.lines.extractedCount).toBe(5);
    expect(r.lines.missingLines).toBe(3);
    expect(r.lines.extraLines).toBe(0);
    expect(r.lines.comparedPositions).toBe(5);
    // Denominator stays the truth's count: 5 of 8, not 5 of 5.
    expect(r.lines.exactLines).toEqual({ exact: 5, total: 8 });
  });

  it("counts extra lines", () => {
    const expected = truth();
    const extra = expected.lines[0];
    if (!extra) throw new Error("fixture has no lines");
    const r = compare({ ...expected, lines: [...expected.lines, extra] }, expected);

    expect(r.lines.extraLines).toBe(1);
    expect(r.lines.missingLines).toBe(0);
  });

  it("handles an empty statement without dividing by zero", () => {
    const empty = buildStatementDraft({ documentId: OPTIONS.documentId, lineCount: 0 });
    const r = compare(empty, empty);
    expect(r.lines.exactLines).toEqual({ exact: 0, total: 0 });
    expect(ratio(r.lines.exactLines)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Counts, never quotes
// ---------------------------------------------------------------------------

describe("a report names positions, never values", () => {
  it("does not quote a mismatched description or amount", () => {
    // An accuracy report is read where a log is read; the report of a failure
    // must not become the leak.
    const base = truth();
    const first = base.lines[0];
    if (!first) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = {
      ...first,
      description: "CONFIDENTIAL PAYEE SDN BHD",
      debit: sen(4_242_42n),
      credit: sen(0n),
    };

    const serialised = JSON.stringify(compare({ ...base, lines }), (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialised).not.toContain("CONFIDENTIAL");
    expect(serialised).not.toContain("424242");
    expect(serialised).toContain('"mismatchedPositions":[0]');
  });

  it("returns null rather than a percentage over an empty denominator", () => {
    // "100% of zero lines" is the kind of number that reaches a status update.
    expect(ratio({ exact: 0, total: 0 })).toBeNull();
    expect(ratio({ exact: 1, total: 2 })).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

describe("aggregate across documents", () => {
  function results(): DocumentAccuracy[] {
    return [
      compare(truth(), truth(), { documentId: "doc-a", measuredAt: "2026-07-28" }),
      compare(corruptLineAmount(truth(), 2, 1n), truth(), {
        documentId: "doc-b",
        measuredAt: "2026-07-30",
        actualReconciled: false,
      }),
    ];
  }

  it("sums counts across documents", () => {
    const summary = aggregate(results());
    expect(summary.documents).toBe(2);
    expect(summary.lines).toEqual({ exact: 15, total: 16 });
    expect(summary.headerFields).toEqual({ exact: 14, total: 14 });
  });

  it("counts reconciliation agreement and fully-exact documents", () => {
    const summary = aggregate(results());
    expect(summary.reconciliationAgreement).toEqual({ exact: 1, total: 2 });
    expect(summary.documentsFullyExact).toEqual({ exact: 1, total: 2 });
  });

  it("records the measurement window", () => {
    const summary = aggregate(results());
    expect(summary.measuredFrom).toBe("2026-07-28");
    expect(summary.measuredTo).toBe("2026-07-30");
  });

  it("groups without any bank being named today", () => {
    // M2b populates `group`; the mechanism must already work.
    const grouped = [
      compare(truth(), truth(), { documentId: "a", group: "layout-1" }),
      compare(truth(), truth(), { documentId: "b", group: "layout-1" }),
      compare(truth(), truth(), { documentId: "c", group: "layout-2" }),
    ];
    const summary = aggregate(grouped);

    expect(summary.groups).toBe(2);
    expect(summary.byGroup.get("layout-1")?.documents).toBe(2);
    expect(summary.byGroup.get("layout-2")?.documents).toBe(1);
    expect(summary.byGroup.get("layout-1")?.lines.total).toBe(16);
  });

  it("buckets ungrouped results rather than dropping them", () => {
    const summary = aggregate(results());
    expect(summary.byGroup.get("(ungrouped)")?.documents).toBe(2);
  });

  it("aggregates nothing without dividing by zero", () => {
    const summary = aggregate([]);
    expect(summary.documents).toBe(0);
    expect(summary.measuredFrom).toBeUndefined();
  });
});

describe("the sentence CLAUDE.md asks for", () => {
  it("leads with counts and never reports a bare percentage", () => {
    const summary = aggregate([
      compare(corruptLineAmount(truth(), 1, 1n), truth(), { documentId: "a" }),
    ]);
    const line = formatAggregate(summary);

    expect(line).toContain("7 of 8 transactions exact");
    expect(line).toContain("across 1 document(s)");
    expect(line).toContain("measured 2026-07-30");
    // A percentage may accompany a count; it may not stand alone.
    expect(line).toMatch(/\d+ of \d+ transactions exact \(\d+\.\d%\)/);
  });

  it("says n/a rather than 100% when nothing was measured", () => {
    expect(formatAggregate(aggregate([]))).toContain("n/a");
    expect(formatAggregate(aggregate([]))).toContain("no measurements");
  });
});
