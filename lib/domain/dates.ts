/**
 * Statement dates.
 *
 * `CLAUDE.md` § Dates names this hazard as the worst failure mode this project
 * has: a date parsed with the wrong day/month
 * order is a silent, plausible-looking wrong answer. `03/04/2026` is a valid
 * date under either reading, reconciles perfectly either way, and lands a
 * transaction a month out of period without anything looking wrong.
 *
 * The response is that **ambiguity is a failure, not a default**. Where two
 * readings are both calendar-valid this module refuses to choose, and a caller
 * that knows a layout's convention must say so explicitly via `assume`. There is
 * no implicit fallback, because an implicit fallback is exactly the silent
 * choice being guarded against.
 *
 * A live specimen from this project's own document set: an invoice dated
 * `09/01/2025` was resolvable only because its body separately printed
 * "9th January 2025". Corroboration like that is a luxury; a statement column
 * will not provide it.
 *
 * Canonical storage is an ISO-8601 calendar date, `YYYY-MM-DD`. Deliberately not
 * a timestamp: a transaction date has no time and no zone, and attaching
 * midnight-UTC to it would invent precision the document does not contain and
 * would shift the date by a day for anyone rendering in Malaysian local time.
 */

import { fail, ok, type Result } from "./failures";

export type IsoDate = string & { readonly __isoDate: unique symbol };

/** Which reading produced the value. Carried so the accuracy harness and any
 *  future review screen can show *why* a date was read the way it was. */
export type DateInterpretation = "ISO" | "DMY" | "MDY" | "MONTH_NAME";

export interface ParsedDate {
  readonly value: IsoDate;
  /** The token exactly as it appeared. Provenance: a reviewer comparing against
   *  the page needs to see what was printed, not what we made of it. */
  readonly raw: string;
  readonly interpretation: DateInterpretation;
}

export interface ParseDateOptions {
  /**
   * Resolve an otherwise-ambiguous token under a known convention.
   *
   * This is a per-call decision by something that has evidence -- a bank layout
   * identified in M2b, or a human. It is deliberately not defaulted to `"DMY"`
   * even though `CLAUDE.md` documents that as the Malaysian convention: a
   * default would resolve every ambiguous date silently, which is the failure
   * this module exists to prevent.
   */
  readonly assume?: "DMY" | "MDY";
}

/**
 * Accepted year range.
 *
 * Not a business rule -- a guard against garbage. Year 0 or year 9999 out of an
 * extraction is a misread token, and letting it through produces a statement
 * that sorts to the beginning or end of every list forever.
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2199;

const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ["JAN", 1], ["JANUARY", 1],
  ["FEB", 2], ["FEBRUARY", 2],
  ["MAR", 3], ["MARCH", 3],
  ["APR", 4], ["APRIL", 4],
  ["MAY", 5],
  ["JUN", 6], ["JUNE", 6],
  ["JUL", 7], ["JULY", 7],
  ["AUG", 8], ["AUGUST", 8],
  ["SEP", 9], ["SEPT", 9], ["SEPTEMBER", 9],
  ["OCT", 10], ["OCTOBER", 10],
  ["NOV", 11], ["NOVEMBER", 11],
  ["DEC", 12], ["DECEMBER", 12],
]);

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/;
const MONTH_NAMED = /^(\d{1,2})[\s.-]+([A-Za-z]+)[\s.,-]+(\d{4})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function toIso(year: number, month: number, day: number): IsoDate {
  const mm = month.toString().padStart(2, "0");
  const dd = day.toString().padStart(2, "0");
  return `${year}-${mm}-${dd}` as IsoDate;
}

/** Validates an already-canonical `YYYY-MM-DD`, e.g. read back from Postgres. */
export function isoDate(value: string): Result<IsoDate> {
  const m = ISO.exec(value.trim());
  if (!m) return fail("AMBIGUOUS_DATE", "not an ISO-8601 calendar date");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidCalendarDate(year, month, day)) {
    return fail("AMBIGUOUS_DATE", `not a real calendar date: ${value.trim()}`);
  }
  return ok(toIso(year, month, day));
}

/**
 * Parses a date as printed on a statement.
 *
 * **Failures quote the token.** Unlike a monetary value, a date is provenance
 * rather than financial content, and a report that will not say which token was
 * ambiguous cannot be acted on. Nothing else about the document is included.
 */
export function parseStatementDate(
  raw: string,
  options: ParseDateOptions = {},
): Result<ParsedDate> {
  const original = raw.trim();
  if (original.length === 0) {
    return fail("AMBIGUOUS_DATE", "empty date");
  }

  const iso = ISO.exec(original);
  if (iso) {
    const parsed = isoDate(original);
    if (!parsed.ok) return parsed;
    return ok({ value: parsed.value, raw: original, interpretation: "ISO" });
  }

  const named = MONTH_NAMED.exec(original);
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_NAMES.get((named[2] ?? "").toUpperCase());
    const year = Number(named[3]);
    if (month === undefined) {
      return fail("AMBIGUOUS_DATE", `unrecognised month name in: ${original}`);
    }
    if (!isValidCalendarDate(year, month, day)) {
      return fail("AMBIGUOUS_DATE", `not a real calendar date: ${original}`);
    }
    // A named month cannot be confused with a day. This is the one printed form
    // that carries no ambiguity at all.
    return ok({
      value: toIso(year, month, day),
      raw: original,
      interpretation: "MONTH_NAME",
    });
  }

  const numeric = NUMERIC.exec(original);
  if (!numeric) {
    return fail("AMBIGUOUS_DATE", `unrecognised date format: ${original}`);
  }

  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const yearToken = numeric[3] ?? "";
  const year = Number(yearToken);

  if (yearToken.length !== 4) {
    // `01/02/25` could be 1925 or 2025, and a century guess is the same class of
    // silent error as a day/month guess.
    return fail(
      "AMBIGUOUS_DATE",
      `two-digit year cannot be resolved: ${original}`,
    );
  }

  const dmyValid = isValidCalendarDate(year, second, first);
  const mdyValid = isValidCalendarDate(year, first, second);

  if (!dmyValid && !mdyValid) {
    return fail("AMBIGUOUS_DATE", `not a real calendar date: ${original}`);
  }

  if (dmyValid && mdyValid) {
    // Same numbers both ways (05/05) -- one date, nothing to choose between.
    if (first === second) {
      return ok({
        value: toIso(year, second, first),
        raw: original,
        interpretation: "DMY",
      });
    }
    const assume = options.assume;
    if (assume === "DMY") {
      return ok({
        value: toIso(year, second, first),
        raw: original,
        interpretation: "DMY",
      });
    }
    if (assume === "MDY") {
      return ok({
        value: toIso(year, first, second),
        raw: original,
        interpretation: "MDY",
      });
    }
    return fail(
      "AMBIGUOUS_DATE",
      `day and month are both <= 12 and no convention was supplied: ${original}`,
    );
  }

  if (dmyValid) {
    return ok({
      value: toIso(year, second, first),
      raw: original,
      interpretation: "DMY",
    });
  }

  // Only MM/DD yields a real date. That is unambiguous as arithmetic but
  // contradicts the convention `CLAUDE.md` documents for Malaysian statements,
  // so it still needs someone to say so rather than being accepted quietly --
  // in practice it means the token was misread or the document is not local.
  if (options.assume === "MDY") {
    return ok({
      value: toIso(year, first, second),
      raw: original,
      interpretation: "MDY",
    });
  }
  return fail(
    "AMBIGUOUS_DATE",
    `only MM/DD/YYYY yields a valid date but DD/MM/YYYY is expected: ${original}`,
  );
}

/** Chronological comparison. ISO calendar dates sort correctly as strings. */
export function compareIsoDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
