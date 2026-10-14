/**
 * The reconciliation gate.
 *
 * `CLAUDE.md` non-negotiable 3: reconciliation is a gate, not a report. For any
 * bank statement,
 *
 *     opening + Σ(credits) − Σ(debits) = closing
 *
 * Off by any amount and the statement is an exception for a human. There is no
 * threshold below which a mismatch is ignored, and **this module deliberately
 * takes no tolerance parameter** -- an API that accepts one is an API somebody
 * eventually passes `1` to in order to make a fixture pass.
 *
 * Sign convention, consistent with `lib/domain/money`: a credit is money in and
 * increases the balance; a debit is money out and decreases it. Statement
 * columns are printed from the account holder's perspective, not the bank's.
 *
 * Pure and I/O-free (`CLAUDE.md` § Rules), so it is exhaustively testable with
 * no fixtures, no database and no network. It is the correctness oracle every
 * later extraction is measured against, which is why it is built before any
 * extractor exists.
 *
 * **Three states, distinguished by type rather than by convention:**
 *
 *   StatementDraft        - proposed; may be malformed
 *   Statement             - structurally valid (`validateStatement`)
 *   ReconciledStatement   - structurally valid AND balanced (`requireReconciled`)
 *
 * Nothing downstream can accept a statement that has not passed the gate,
 * because the type it needs cannot be produced any other way. That is what
 * makes "no code path from a failed reconciliation to an export row" a property
 * of the compiler rather than a promise in a comment.
 */

import { fail, ok, type Result } from "@/lib/domain/failures";
import {
  ZERO,
  addSen,
  formatSen,
  isZero,
  subSen,
  sumSen,
  type Sen,
} from "@/lib/domain/money";
import type { Statement } from "@/lib/domain/statement";

/**
 * Whether the running balances the document printed agree with its own lines.
 *
 * `not-available` means the statement did not print a balance on every line --
 * absent is not zero.
 *
 * **Advisory in M2a, not part of the gate.** It catches a class the endpoint
 * equation cannot: two errors that cancel out. Promoting it to a gate needs
 * corpus evidence that banks print running balances consistently (including
 * around fees and reversals), which is an M2b question. Reporting it now costs
 * nothing and gives that question a measurement to answer with.
 */
export type RunningBalanceCheck =
  | { readonly status: "not-available" }
  | { readonly status: "consistent" }
  | {
      readonly status: "inconsistent";
      /** 1-indexed position of the first line whose printed balance disagrees. */
      readonly firstDivergentLine: number;
      readonly expected: Sen;
      readonly stated: Sen;
    };

/**
 * The arithmetic, with each value labelled by where it came from.
 *
 * The provenance distinction is the point: `openingBalance` and `statedClosing`
 * are what the document asserts, while `totalCredits`, `totalDebits` and
 * `computedClosing` are what addition produces from the lines. Non-negotiable 2
 * is that no number here was produced by a language model -- every computed
 * field on this object is the output of `+` and `-` over extracted line items.
 */
export interface ReconciliationResult {
  readonly reconciled: boolean;
  /** Stated by the document. */
  readonly openingBalance: Sen;
  /** Stated by the document. */
  readonly statedClosing: Sen;
  /** Computed from the lines. */
  readonly totalCredits: Sen;
  /** Computed from the lines. */
  readonly totalDebits: Sen;
  /** Computed: opening + credits − debits. */
  readonly computedClosing: Sen;
  /** Computed − stated. Zero exactly when the statement reconciles. */
  readonly delta: Sen;
  readonly lineCount: number;
  readonly runningBalances: RunningBalanceCheck;
}

/** A statement whose arithmetic has been checked and passed. */
export type ReconciledStatement = Statement & {
  readonly __reconciled: unique symbol;
};

function checkRunningBalances(statement: Statement): RunningBalanceCheck {
  if (statement.lines.length === 0) return { status: "not-available" };
  if (statement.lines.some((l) => l.runningBalance === undefined)) {
    return { status: "not-available" };
  }

  let expected = statement.openingBalance;
  for (let i = 0; i < statement.lines.length; i += 1) {
    const line = statement.lines[i];
    if (line?.runningBalance === undefined) return { status: "not-available" };
    expected = subSen(addSen(expected, line.credit), line.debit);
    if (expected !== line.runningBalance) {
      return {
        status: "inconsistent",
        firstDivergentLine: i + 1,
        expected,
        stated: line.runningBalance,
      };
    }
  }
  return { status: "consistent" };
}

/**
 * Computes the arithmetic. Always succeeds -- it reports, it does not decide.
 *
 * Use `requireReconciled` where a decision is needed. This exists separately so
 * an exception queue can show a reviewer *how far out* a statement is, which a
 * boolean cannot.
 */
export function reconcile(statement: Statement): ReconciliationResult {
  const totalCredits = sumSen(statement.lines.map((l) => l.credit));
  const totalDebits = sumSen(statement.lines.map((l) => l.debit));
  const computedClosing = subSen(
    addSen(statement.openingBalance, totalCredits),
    totalDebits,
  );
  const delta = subSen(computedClosing, statement.closingBalance);

  return {
    reconciled: isZero(delta),
    openingBalance: statement.openingBalance,
    statedClosing: statement.closingBalance,
    totalCredits,
    totalDebits,
    computedClosing,
    delta,
    lineCount: statement.lines.length,
    runningBalances: checkRunningBalances(statement),
  };
}

/**
 * The gate.
 *
 * Returns a `ReconciledStatement` or a `RECONCILIATION_FAILED` failure. The
 * delta is quoted in the detail because an accountant chasing a break needs the
 * amount -- unlike a malformed value, a reconciliation delta is the finding
 * itself, and withholding it would make the exception unactionable.
 */
export function requireReconciled(
  statement: Statement,
): Result<ReconciledStatement> {
  const result = reconcile(statement);
  if (!result.reconciled) {
    return fail(
      "RECONCILIATION_FAILED",
      `statement does not balance: computed closing differs from stated by ${formatSen(result.delta)}`,
    );
  }
  return ok(statement as ReconciledStatement);
}

/** Convenience for an empty run of lines, so callers need not special-case it. */
export const NO_MOVEMENT: Sen = ZERO;
