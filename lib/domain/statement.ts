/**
 * The canonical statement: what the source document says, and nothing else.
 *
 * **The firewall.** This model describes a bank statement. It does not describe
 * what anyone intends to do with it. GL account codes, tax codes, customer or
 * supplier codes, posting status, review status, chart-of-account mappings and
 * every accounting-system identifier are deliberately absent -- those are
 * properties of a *posting* (M3a) or of a *destination artifact* (M3b), and each
 * is decided by evidence this project does not yet have.
 *
 *     SourceDocument -> Statement -> Posting -> DestinationArtifact
 *                       ^^^^^^^^^
 *                       this file, and only this
 *
 * The rule is enforced mechanically, not by discipline: `statement.test.ts`
 * scans this directory for the forbidden vocabulary and fails if any of it
 * appears. A field that exists only to serve a hypothetical future format is a
 * field nobody can validate against a real document.
 *
 * **Two states, distinguished by type.** A `StatementDraft` is a shape someone
 * proposed. A `Statement` has passed structural validation and can only be
 * obtained from `validateStatement`; the brand makes an object literal
 * impossible outside this module. `lib/reconcile` adds the third state.
 */

import { compareIsoDates, type IsoDate } from "./dates";
import { fail, ok, type Result } from "./failures";
import { isNegative, isZero, type Sen } from "./money";

/**
 * Where a value came from, precise enough for a reviewer to find it on the page.
 *
 * `locator` is whatever the producing parser can offer -- a row index, a text
 * span, a cell reference. It is opaque here on purpose: constraining it would
 * mean guessing what a parser that does not exist yet can report.
 */
export interface SourceRef {
  readonly documentId: string;
  /** 1-indexed, as a human counts pages. */
  readonly page: number;
  readonly locator?: string;
}

export interface StatementLine {
  /** Canonical date. */
  readonly date: IsoDate;
  /** The date token exactly as printed. A reviewer checking against the page
   *  needs what was there, not what we made of it. */
  readonly dateRaw: string;
  /** The description as printed. Never normalised, never enriched: inferring a
   *  counterparty from it is an M3a concern with a human in the loop. */
  readonly description: string;
  /** Magnitude of money out. Non-negative; direction is positional. */
  readonly debit: Sen;
  /** Magnitude of money in. Non-negative; direction is positional. */
  readonly credit: Sen;
  /** Balance after this line, where the statement prints one. Absent means the
   *  document did not state it -- not zero. */
  readonly runningBalance?: Sen;
  readonly source: SourceRef;
}

export interface StatementDraft {
  /** The account identifier as printed. Not normalised and not resolved against
   *  anything: it is a string on a page. */
  readonly accountReference: string;
  /** ISO 4217. Stated rather than assumed, so a foreign-currency account is a
   *  visible fact rather than a silent MYR mis-read. */
  readonly currency: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly openingBalance: Sen;
  readonly closingBalance: Sen;
  readonly lines: readonly StatementLine[];
  readonly source: {
    readonly documentId: string;
    readonly pageCount: number;
  };
}

/** A draft that has passed `validateStatement`. Not constructible directly. */
export type Statement = StatementDraft & {
  readonly __validated: unique symbol;
};

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Structural validation.
 *
 * Distinct from reconciliation on purpose. This answers "is this a
 * well-formed statement?"; `lib/reconcile` answers "does it add up?". A
 * statement can be structurally perfect and fail arithmetic, and conflating the
 * two would report a misread column as a balance error.
 *
 * **Failure details name positions, never values.** A line description and an
 * amount are both financial content; `lib/domain/failures.ts` documents the
 * rule and this module keeps it by reporting line index and page instead.
 */
export function validateStatement(draft: StatementDraft): Result<Statement> {
  if (draft.accountReference.trim().length === 0) {
    return fail("EXTRACTION_VALIDATION_FAILED", "account reference is blank");
  }
  if (!CURRENCY.test(draft.currency)) {
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      "currency is not a three-letter ISO 4217 code",
    );
  }
  if (compareIsoDates(draft.periodStart, draft.periodEnd) === 1) {
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      "statement period starts after it ends",
    );
  }
  if (draft.source.pageCount < 1) {
    return fail("EXTRACTION_VALIDATION_FAILED", "page count is not positive");
  }
  if (draft.source.documentId.trim().length === 0) {
    return fail("EXTRACTION_VALIDATION_FAILED", "source document id is blank");
  }

  for (let i = 0; i < draft.lines.length; i += 1) {
    const line = draft.lines[i];
    if (line === undefined) continue;
    const at = `line ${i + 1} (page ${line.source.page})`;

    if (isNegative(line.debit) || isNegative(line.credit)) {
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: debit and credit are magnitudes and cannot be negative`,
      );
    }
    if (!isZero(line.debit) && !isZero(line.credit)) {
      // A transaction moves money one way. Both populated means the debit and
      // credit columns were read into each other.
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: both a debit and a credit are present`,
      );
    }
    if (isZero(line.debit) && isZero(line.credit)) {
      // Usually a wrapped description row that was split into its own line, or a
      // header mistaken for a transaction. Deliberately strict: a zero-value row
      // contributes nothing to the arithmetic but does inflate the line count
      // the accuracy harness measures against.
      // Reconsider if a real statement is found that prints a genuine zero-value
      // transaction -- that is a corpus question, not a design one.
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: neither a debit nor a credit is present`,
      );
    }
    if (line.description.trim().length === 0) {
      return fail("EXTRACTION_VALIDATION_FAILED", `${at}: description is blank`);
    }
    if (line.dateRaw.trim().length === 0) {
      return fail("EXTRACTION_VALIDATION_FAILED", `${at}: date token is blank`);
    }
    if (line.source.page < 1 || line.source.page > draft.source.pageCount) {
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: page is outside the document`,
      );
    }
    if (line.source.documentId !== draft.source.documentId) {
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: belongs to a different source document`,
      );
    }
  }

  // Deliberately NOT validated: that every line date falls inside the statement
  // period. Value date and posting date legitimately differ, and without a real
  // corpus any bound would be invented. An M2b question, recorded rather than
  // guessed at.

  return ok(draft as Statement);
}
