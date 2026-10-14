/**
 * Synthetic statement fixtures, generated rather than committed.
 *
 * `CLAUDE.md` non-negotiable 1 and the M1 data policy: fixtures are produced at
 * test time and never stored as binaries, so there is no directory where a real
 * statement can eventually be dropped "just to test something".
 *
 * Everything here is deterministic. A seeded generator means a failing case is
 * reproducible from its seed alone, which matters once the accuracy harness
 * starts reporting counts rather than pass/fail.
 *
 * These are shapes, not documents. They exercise arithmetic and invariants; they
 * say nothing about how any real bank prints a statement, and no layout may be
 * inferred from them (non-negotiable 8).
 */

import { isoDate, type IsoDate } from "./dates";
import { sen, type Sen } from "./money";
import type { StatementDraft, StatementLine } from "./statement";

/** mulberry32 — small, fast, and identical on every platform. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function requireIso(value: string): IsoDate {
  const r = isoDate(value);
  if (!r.ok) throw new Error(`fixture built an invalid date: ${value}`);
  return r.value;
}

export interface SyntheticStatementOptions {
  readonly documentId?: string;
  readonly lineCount?: number;
  readonly seed?: number;
  readonly openingBalance?: Sen;
  /** Emit a printed balance on every line. Off by default: many statements do
   *  not print one, and absent must not be confused with zero. */
  readonly withRunningBalances?: boolean;
  readonly currency?: string;
  readonly pageCount?: number;
}

/**
 * Builds a structurally valid, exactly balanced statement.
 *
 * The closing balance is computed from the generated lines rather than chosen,
 * so a fixture cannot silently drift out of balance and quietly weaken a test
 * that was supposed to prove the gate rejects.
 */
export function buildStatementDraft(
  options: SyntheticStatementOptions = {},
): StatementDraft {
  const {
    documentId = "00000000-0000-7000-8000-000000000001",
    lineCount = 12,
    seed = 1,
    openingBalance = sen(1_000_00n),
    withRunningBalances = false,
    currency = "MYR",
    // Declared after `lineCount` so it can derive from it: ten lines to a page.
    pageCount = Math.max(1, Math.ceil(lineCount / 10)),
  } = options;

  const random = seededRandom(seed);
  const lines: StatementLine[] = [];
  let balance = openingBalance;

  for (let i = 0; i < lineCount; i += 1) {
    // Magnitudes between 0.01 and 9,999.99 -- wide enough that grouping and
    // fractional sen both appear, small enough to stay readable in a failure.
    const magnitude = sen(BigInt(1 + Math.floor(random() * 999_999)));
    const isCredit = random() < 0.5;
    const debit = isCredit ? sen(0n) : magnitude;
    const credit = isCredit ? magnitude : sen(0n);
    balance = sen(balance + credit - debit);

    // Day is forced above 12 so the printed token is unambiguous under
    // DD/MM/YYYY -- an ambiguous fixture date would test the date parser by
    // accident from inside a reconciliation test.
    const day = 13 + (i % 15);
    const month = 7;
    const year = 2026;
    const dd = day.toString().padStart(2, "0");
    const mm = month.toString().padStart(2, "0");

    const line: StatementLine = {
      date: requireIso(`${year}-${mm}-${dd}`),
      dateRaw: `${dd}/${mm}/${year}`,
      description: `SYNTHETIC TRANSACTION ${i + 1}`,
      debit,
      credit,
      source: {
        documentId,
        page: Math.min(pageCount, 1 + Math.floor(i / 10)),
        locator: `row:${i + 1}`,
      },
      ...(withRunningBalances ? { runningBalance: balance } : {}),
    };
    lines.push(line);
  }

  return {
    accountReference: "SAMPLEBANK 1234567890",
    currency,
    periodStart: requireIso("2026-07-01"),
    periodEnd: requireIso("2026-07-31"),
    openingBalance,
    closingBalance: balance,
    lines,
    source: { documentId, pageCount },
  };
}

/**
 * Alters one line's amount by `delta` sen, leaving everything else intact.
 *
 * This is the mandatory negative control from `CLAUDE.md` § Verification: feed
 * the gate a statement with one transaction altered by 1 sen and assert it
 * fails. Any printed running balances are left as they were, which is what a
 * genuine misread would look like.
 */
export function corruptLineAmount(
  draft: StatementDraft,
  lineIndex: number,
  delta: bigint,
): StatementDraft {
  const target = draft.lines[lineIndex];
  if (target === undefined) {
    throw new Error(`fixture has no line at index ${lineIndex}`);
  }
  const corrupted: StatementLine =
    target.credit !== 0n
      ? { ...target, credit: sen(target.credit + delta) }
      : { ...target, debit: sen(target.debit + delta) };

  const lines = [...draft.lines];
  lines[lineIndex] = corrupted;
  return { ...draft, lines };
}

/** Alters the *stated* closing balance, leaving the lines correct. */
export function corruptStatedClosing(
  draft: StatementDraft,
  delta: bigint,
): StatementDraft {
  return { ...draft, closingBalance: sen(draft.closingBalance + delta) };
}
