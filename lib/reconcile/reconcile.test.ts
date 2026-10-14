import { describe, expect, it } from "vitest";

import { sen } from "@/lib/domain/money";
import { validateStatement, type StatementDraft } from "@/lib/domain/statement";
import {
  buildStatementDraft,
  corruptLineAmount,
  corruptStatedClosing,
} from "@/lib/domain/testing";

import { reconcile, requireReconciled } from "./index";

/** Structural validation is a separate gate; these tests assume it passed. */
function validated(draft: StatementDraft) {
  const r = validateStatement(draft);
  if (!r.ok) throw new Error(`fixture is structurally invalid: ${r.failure.detail}`);
  return r.value;
}

describe("a balanced statement reconciles", () => {
  it("passes the gate", () => {
    const r = requireReconciled(validated(buildStatementDraft()));
    expect(r.ok).toBe(true);
  });

  it.each([1, 2, 5, 12, 37, 120])("balances with %i lines", (lineCount) => {
    const statement = validated(buildStatementDraft({ lineCount, seed: lineCount }));
    const result = reconcile(statement);
    expect(result.reconciled).toBe(true);
    expect(result.delta).toBe(0n);
    expect(result.lineCount).toBe(lineCount);
  });

  it("balances a period with no movement", () => {
    const statement = validated(buildStatementDraft({ lineCount: 0 }));
    const result = reconcile(statement);
    expect(result.reconciled).toBe(true);
    expect(result.totalCredits).toBe(0n);
    expect(result.totalDebits).toBe(0n);
    expect(result.computedClosing).toBe(result.openingBalance);
  });
});

// ---------------------------------------------------------------------------
// The mandatory negative control
// ---------------------------------------------------------------------------

describe("a one-sen corruption is rejected", () => {
  // CLAUDE.md § Verification: "Prove reconciliation rejects -- feed it a
  // statement with one transaction altered by 1 sen and assert it fails."
  // A gate tested only on the passing case is indistinguishable from
  // `return true`.

  it.each([0, 5, 11])("fails when line %i is one sen too high", (index) => {
    const draft = corruptLineAmount(buildStatementDraft({ lineCount: 12 }), index, 1n);
    const result = reconcile(validated(draft));

    expect(result.reconciled).toBe(false);
    expect(result.delta).toBe(1n);
  });

  it.each([0, 5, 11])("fails when line %i is one sen too low", (index) => {
    const draft = corruptLineAmount(buildStatementDraft({ lineCount: 12 }), index, -1n);
    const result = reconcile(validated(draft));

    expect(result.reconciled).toBe(false);
    expect(result.delta).toBe(-1n);
  });

  it("refuses to produce a reconciled statement from it", () => {
    const draft = corruptLineAmount(buildStatementDraft(), 3, 1n);
    const r = requireReconciled(validated(draft));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("RECONCILIATION_FAILED");
      expect(r.failure.detail).toContain("0.01");
    }
  });

  it("has no tolerance parameter to weaken", () => {
    // The signature is the proof: there is nowhere to pass a threshold. One sen
    // out of a RM100,000 statement still fails.
    const big = buildStatementDraft({ lineCount: 40, openingBalance: sen(100_000_00n) });
    const draft = corruptLineAmount(big, 20, 1n);
    expect(reconcile(validated(draft)).reconciled).toBe(false);
    expect(requireReconciled).toHaveLength(1);
  });

  it("detects a corrupted stated closing balance with correct lines", () => {
    // The mirror case: the arithmetic is right and the document's own total is
    // wrong. Same verdict, opposite cause.
    const draft = corruptStatedClosing(buildStatementDraft(), -1n);
    const result = reconcile(validated(draft));
    expect(result.reconciled).toBe(false);
    expect(result.delta).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("stated and computed values stay distinguishable", () => {
  it("labels which figures came from the document and which from addition", () => {
    // Non-negotiable 2: every total here is the output of + and -, never of a
    // language model. Keeping the stated values beside the computed ones is what
    // lets an exception queue show a reviewer both.
    const draft = buildStatementDraft({ lineCount: 6, seed: 99 });
    const statement = validated(draft);
    const result = reconcile(statement);

    expect(result.openingBalance).toBe(draft.openingBalance);
    expect(result.statedClosing).toBe(draft.closingBalance);

    let credits = 0n;
    let debits = 0n;
    for (const line of draft.lines) {
      credits += line.credit;
      debits += line.debit;
    }
    expect(result.totalCredits).toBe(credits);
    expect(result.totalDebits).toBe(debits);
    expect(result.computedClosing).toBe(draft.openingBalance + credits - debits);
  });

  it("reports delta as computed minus stated", () => {
    const draft = corruptStatedClosing(buildStatementDraft(), 500n);
    const result = reconcile(validated(draft));
    expect(result.delta).toBe(-500n);
  });

  it("is exact for values beyond Number.MAX_SAFE_INTEGER", () => {
    const draft = buildStatementDraft({
      lineCount: 8,
      openingBalance: sen(9_007_199_254_740_993n),
    });
    expect(reconcile(validated(draft)).reconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Running balances (advisory)
// ---------------------------------------------------------------------------

describe("printed running balances", () => {
  it("reports not-available when the document did not print them", () => {
    const statement = validated(buildStatementDraft({ lineCount: 5 }));
    expect(reconcile(statement).runningBalances.status).toBe("not-available");
  });

  it("confirms consistency when every line carries one", () => {
    const statement = validated(
      buildStatementDraft({ lineCount: 9, withRunningBalances: true }),
    );
    expect(reconcile(statement).runningBalances.status).toBe("consistent");
  });

  it("locates the first divergence after a corruption", () => {
    const draft = corruptLineAmount(
      buildStatementDraft({ lineCount: 9, withRunningBalances: true }),
      4,
      1n,
    );
    const check = reconcile(validated(draft)).runningBalances;

    expect(check.status).toBe("inconsistent");
    if (check.status === "inconsistent") {
      expect(check.firstDivergentLine).toBe(5); // 1-indexed
      // Magnitude, not sign: the corruption lands on whichever column the line
      // populated, so a debit diverges downward and a credit upward. Asserting
      // the direction would hard-code which side the seeded fixture happened to
      // generate rather than the property under test.
      const divergence = check.expected - check.stated;
      expect(divergence === 1n || divergence === -1n).toBe(true);
    }
  });

  it("catches two errors that cancel out, which the endpoint check cannot", () => {
    // The reason this advisory check earns its place: +1 sen on one line and
    // -1 sen on another leaves opening + credits - debits exactly right.
    const base = buildStatementDraft({ lineCount: 9, withRunningBalances: true });
    const draft = corruptLineAmount(corruptLineAmount(base, 2, 1n), 6, -1n);
    const result = reconcile(validated(draft));

    expect(result.reconciled).toBe(true); // endpoints agree
    expect(result.runningBalances.status).toBe("inconsistent"); // lines do not
  });

  it("does not block the gate, because promoting it needs corpus evidence", () => {
    // Advisory in M2a by decision, not by oversight. Whether banks print
    // running balances consistently around fees and reversals is an M2b
    // question, and gating on an unvalidated assumption would reject good
    // statements.
    const base = buildStatementDraft({ lineCount: 9, withRunningBalances: true });
    const draft = corruptLineAmount(corruptLineAmount(base, 2, 1n), 6, -1n);
    expect(requireReconciled(validated(draft)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The three states
// ---------------------------------------------------------------------------

describe("the three states are distinguishable", () => {
  it("separates structurally invalid from arithmetically unreconciled", () => {
    const base = buildStatementDraft({ lineCount: 4 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");

    // Structurally invalid: never reaches the arithmetic at all.
    const lines = [...base.lines];
    lines[0] = { ...first, debit: sen(1n), credit: sen(1n) };
    const structural = validateStatement({ ...base, lines });
    expect(structural.ok).toBe(false);
    if (!structural.ok) {
      expect(structural.failure.kind).toBe("EXTRACTION_VALIDATION_FAILED");
    }

    // Structurally valid, arithmetically wrong: a different kind entirely.
    const arithmetic = requireReconciled(
      validated(corruptLineAmount(base, 0, 1n)),
    );
    expect(arithmetic.ok).toBe(false);
    if (!arithmetic.ok) {
      expect(arithmetic.failure.kind).toBe("RECONCILIATION_FAILED");
    }

    // Valid and reconciled.
    expect(requireReconciled(validated(base)).ok).toBe(true);
  });

  it("reports without deciding, and decides separately", () => {
    // `reconcile` always succeeds so an exception queue can show how far out a
    // statement is; `requireReconciled` is the gate.
    const draft = corruptLineAmount(buildStatementDraft(), 1, 1n);
    const statement = validated(draft);

    expect(reconcile(statement).reconciled).toBe(false);
    expect(requireReconciled(statement).ok).toBe(false);
  });

  it("returns the same statement object when the gate passes", () => {
    const statement = validated(buildStatementDraft());
    const r = requireReconciled(statement);
    expect(r.ok && r.value).toBe(statement);
  });
});
