/**
 * The accuracy harness — the mechanism, not the measurement.
 *
 * `CLAUDE.md` § Verification: *"Accuracy is a number, not an impression.
 * 'Extraction works well' is not a result. 'N of M transactions exact across K
 * real statements from J banks, dated' is."* This produces that sentence. It
 * does not produce the number, because the number needs the real corpus M2b
 * waits on.
 *
 * **Ground truth is a `StatementDraft`.** Reusing the domain model rather than
 * inventing a parallel shape is the firewall doing its job: a draft
 * structurally cannot hold a GL account, a tax code or a destination field, so
 * ground truth cannot drift toward what an accounting system expects and away
 * from what the document says.
 *
 * **Counts, never quotes.** A mismatch is reported as a line index and a field
 * class. Nothing here returns an expected-versus-actual description or amount:
 * an accuracy report is read in the same places a log is, and the report of a
 * failure must not become the leak.
 *
 * Pure and I/O-free. No database, no clock beyond the one passed in.
 */

import { compareIsoDates } from "@/lib/domain/dates";
import type { StatementDraft, StatementLine } from "@/lib/domain/statement";

/** `exact of total`. Both are reported; a ratio is derived, never stored. */
export interface Counted {
  readonly exact: number;
  readonly total: number;
}

function counted(exact: number, total: number): Counted {
  return { exact, total };
}

/**
 * Percentage, for display only.
 *
 * Returns `null` for an empty denominator rather than 0 or 100 — "100% of zero
 * lines" is the kind of number that gets quoted in a status update.
 */
export function ratio(c: Counted): number | null {
  return c.total === 0 ? null : c.exact / c.total;
}

export interface HeaderAccuracy {
  readonly accountReference: boolean;
  readonly currency: boolean;
  readonly periodStart: boolean;
  readonly periodEnd: boolean;
  readonly openingBalance: boolean;
  readonly closingBalance: boolean;
  readonly pageCount: boolean;
  /** How many of the seven header fields matched. */
  readonly fields: Counted;
}

export interface LineAccuracy {
  readonly expectedCount: number;
  readonly extractedCount: number;
  /** Positions compared — the shorter of the two counts. */
  readonly comparedPositions: number;
  readonly missingLines: number;
  readonly extraLines: number;
  /** A line is exact only when every compared field matches. */
  readonly exactLines: Counted;
  readonly date: Counted;
  readonly description: Counted;
  /** Whitespace-collapsed comparison, reported beside the strict one. Fuzzy
   *  matching needs a corpus to calibrate and is deferred to M2b. */
  readonly descriptionNormalised: Counted;
  readonly debit: Counted;
  readonly credit: Counted;
  /** Compared only where both sides state one; absent is not zero. */
  readonly runningBalance: Counted;
  /** Positions only. Never the values that differed. */
  readonly mismatchedPositions: readonly number[];
}

export interface ReconciliationAgreement {
  readonly expected: boolean;
  readonly actual: boolean;
  readonly agreed: boolean;
}

export interface DocumentAccuracy {
  readonly documentId: string;
  /** Parser id or model id — the code that produced the extraction. */
  readonly producerId: string;
  readonly runId?: string;
  /** ISO-8601 date the comparison ran. Non-negotiable 7: an undated figure is a bug. */
  readonly measuredAt: string;
  /**
   * Bank or layout label, for grouping in aggregate.
   *
   * Deliberately unset in M2a and deliberately a free string: naming a bank now
   * would be inventing a layout taxonomy before seeing one (non-negotiable 8).
   */
  readonly group?: string;
  readonly header: HeaderAccuracy;
  readonly lines: LineAccuracy;
  readonly reconciliation: ReconciliationAgreement;
}

export interface CompareOptions {
  readonly documentId: string;
  readonly producerId: string;
  readonly runId?: string;
  readonly measuredAt: string;
  readonly group?: string;
  readonly expectedReconciled: boolean;
  readonly actualReconciled: boolean;
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toUpperCase();
}

function compareLine(
  expected: StatementLine,
  actual: StatementLine,
): { readonly fields: boolean[]; readonly exact: boolean } {
  const dateOk = compareIsoDates(expected.date, actual.date) === 0;
  const descriptionOk = expected.description === actual.description;
  const debitOk = expected.debit === actual.debit;
  const creditOk = expected.credit === actual.credit;
  // Both absent counts as agreement; one absent does not.
  const balanceOk = expected.runningBalance === actual.runningBalance;

  return {
    fields: [dateOk, descriptionOk, debitOk, creditOk, balanceOk],
    exact: dateOk && descriptionOk && debitOk && creditOk && balanceOk,
  };
}

/**
 * Compares one extraction against its ground truth.
 *
 * Lines are compared **by position**. Alignment — matching a line that shifted
 * because an earlier one was missed — needs a real corpus to know whether shifts
 * happen and how, so position comparison is the honest mechanism today and a
 * missing line correctly cascades into the positions after it. That cascade is
 * visible in `missingLines` rather than hidden.
 */
export function compareStatements(
  expected: StatementDraft,
  actual: StatementDraft,
  options: CompareOptions,
): DocumentAccuracy {
  const headerFlags = {
    accountReference: expected.accountReference === actual.accountReference,
    currency: expected.currency === actual.currency,
    periodStart: compareIsoDates(expected.periodStart, actual.periodStart) === 0,
    periodEnd: compareIsoDates(expected.periodEnd, actual.periodEnd) === 0,
    openingBalance: expected.openingBalance === actual.openingBalance,
    closingBalance: expected.closingBalance === actual.closingBalance,
    pageCount: expected.source.pageCount === actual.source.pageCount,
  };
  const headerExact = Object.values(headerFlags).filter(Boolean).length;

  const expectedCount = expected.lines.length;
  const extractedCount = actual.lines.length;
  const compared = Math.min(expectedCount, extractedCount);

  let exactLines = 0;
  let dateOk = 0;
  let descriptionOk = 0;
  let descriptionNormalisedOk = 0;
  let debitOk = 0;
  let creditOk = 0;
  let balanceComparable = 0;
  let balanceOk = 0;
  const mismatched: number[] = [];

  for (let i = 0; i < compared; i += 1) {
    const e = expected.lines[i];
    const a = actual.lines[i];
    if (e === undefined || a === undefined) continue;

    const result = compareLine(e, a);
    if (result.exact) exactLines += 1;
    else mismatched.push(i);

    if (result.fields[0]) dateOk += 1;
    if (result.fields[1]) descriptionOk += 1;
    if (normalise(e.description) === normalise(a.description)) {
      descriptionNormalisedOk += 1;
    }
    if (result.fields[2]) debitOk += 1;
    if (result.fields[3]) creditOk += 1;

    if (e.runningBalance !== undefined || a.runningBalance !== undefined) {
      balanceComparable += 1;
      if (result.fields[4]) balanceOk += 1;
    }
  }

  return {
    documentId: options.documentId,
    producerId: options.producerId,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    measuredAt: options.measuredAt,
    ...(options.group === undefined ? {} : { group: options.group }),
    header: { ...headerFlags, fields: counted(headerExact, 7) },
    lines: {
      expectedCount,
      extractedCount,
      comparedPositions: compared,
      missingLines: Math.max(0, expectedCount - extractedCount),
      extraLines: Math.max(0, extractedCount - expectedCount),
      exactLines: counted(exactLines, expectedCount),
      date: counted(dateOk, compared),
      description: counted(descriptionOk, compared),
      descriptionNormalised: counted(descriptionNormalisedOk, compared),
      debit: counted(debitOk, compared),
      credit: counted(creditOk, compared),
      runningBalance: counted(balanceOk, balanceComparable),
      mismatchedPositions: mismatched,
    },
    reconciliation: {
      expected: options.expectedReconciled,
      actual: options.actualReconciled,
      agreed: options.expectedReconciled === options.actualReconciled,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface AggregateAccuracy {
  readonly documents: number;
  readonly groups: number;
  readonly measuredFrom?: string;
  readonly measuredTo?: string;
  readonly lines: Counted;
  readonly headerFields: Counted;
  readonly reconciliationAgreement: Counted;
  readonly documentsFullyExact: Counted;
  /** Per group, so a per-bank breakdown works the day groups are populated. */
  readonly byGroup: ReadonlyMap<string, AggregateAccuracy>;
}

const UNGROUPED = "(ungrouped)";

function sum(values: readonly Counted[]): Counted {
  return counted(
    values.reduce((n, c) => n + c.exact, 0),
    values.reduce((n, c) => n + c.total, 0),
  );
}

function aggregateFlat(results: readonly DocumentAccuracy[]): Omit<
  AggregateAccuracy,
  "byGroup" | "groups"
> {
  const dates = results.map((r) => r.measuredAt).sort();
  const fullyExact = results.filter(
    (r) =>
      r.header.fields.exact === r.header.fields.total &&
      r.lines.exactLines.exact === r.lines.exactLines.total &&
      r.lines.extraLines === 0 &&
      r.reconciliation.agreed,
  ).length;

  return {
    documents: results.length,
    ...(dates[0] === undefined ? {} : { measuredFrom: dates[0] }),
    ...(dates[dates.length - 1] === undefined
      ? {}
      : { measuredTo: dates[dates.length - 1] }),
    lines: sum(results.map((r) => r.lines.exactLines)),
    headerFields: sum(results.map((r) => r.header.fields)),
    reconciliationAgreement: counted(
      results.filter((r) => r.reconciliation.agreed).length,
      results.length,
    ),
    documentsFullyExact: counted(fullyExact, results.length),
  };
}

/** Totals across documents, with a per-group breakdown. */
export function aggregate(
  results: readonly DocumentAccuracy[],
): AggregateAccuracy {
  const groups = new Map<string, DocumentAccuracy[]>();
  for (const result of results) {
    const key = result.group ?? UNGROUPED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(result);
    else groups.set(key, [result]);
  }

  const byGroup = new Map<string, AggregateAccuracy>();
  for (const [key, bucket] of groups) {
    byGroup.set(key, {
      ...aggregateFlat(bucket),
      groups: 1,
      byGroup: new Map(),
    });
  }

  return { ...aggregateFlat(results), groups: groups.size, byGroup };
}

/**
 * The sentence `CLAUDE.md` asks for.
 *
 * Counts first, and a percentage only alongside one. A bare percentage hides
 * the denominator, and "94% accurate" over three documents is not a result.
 */
export function formatAggregate(summary: AggregateAccuracy): string {
  const pct = (c: Counted): string => {
    const r = ratio(c);
    return r === null ? "n/a" : `${(r * 100).toFixed(1)}%`;
  };
  const window =
    summary.measuredFrom === undefined
      ? "no measurements"
      : summary.measuredFrom === summary.measuredTo
        ? summary.measuredFrom
        : `${summary.measuredFrom}..${summary.measuredTo}`;

  return [
    `${summary.lines.exact} of ${summary.lines.total} transactions exact (${pct(summary.lines)})`,
    `across ${summary.documents} document(s) in ${summary.groups} group(s)`,
    `header fields ${summary.headerFields.exact}/${summary.headerFields.total}`,
    `reconciliation agreed ${summary.reconciliationAgreement.exact}/${summary.reconciliationAgreement.total}`,
    `fully exact documents ${summary.documentsFullyExact.exact}/${summary.documentsFullyExact.total}`,
    `measured ${window}`,
  ].join("; ");
}
