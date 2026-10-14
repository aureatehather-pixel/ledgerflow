/**
 * The persistence boundary for domain values.
 *
 * Every conversion between a domain value and a database column happens here and
 * nowhere else, so there is one place to audit rather than a scatter of inline
 * casts.
 *
 * **`bigint` never passes through JSON.** `JSON.stringify` throws on a bigint,
 * and the tempting fix — `Number(value)` — silently loses precision above
 * 2^53 and is exactly the float contamination `CLAUDE.md` § Money forbids.
 * Postgres `bigint` holds the full 64-bit range and Drizzle's `mode: "bigint"`
 * returns a JavaScript bigint, so the value never becomes a `number` at any
 * point. `codec.test.ts` proves the round trip against a real database using
 * values above `Number.MAX_SAFE_INTEGER`.
 *
 * The brands (`Sen`, `Microcents`, `IsoDate`) are erased at runtime, so these
 * functions are identity at the machine level. They exist for the type system
 * and for the reader: a call site that says `senToDb` is a call site someone
 * thought about.
 */

import { isoDate, type IsoDate } from "@/lib/domain/dates";
import { sen, type Sen } from "@/lib/domain/money";
import { microcents, type Microcents } from "@/lib/cost/rates";

// --- money ------------------------------------------------------------------

/** `Sen` -> `bigint` column. */
export function senToDb(value: Sen): bigint {
  return value;
}

/**
 * `bigint` column -> `Sen`.
 *
 * Throws on a `number`, which is the failure this boundary exists to catch: a
 * driver misconfigured to `mode: "number"` would hand back a silently truncated
 * balance, and a wrong balance that looks plausible is worse than a crash.
 */
export function senFromDb(value: unknown): Sen {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `expected a bigint money column, received ${typeof value}`,
    );
  }
  return sen(value);
}

export function senToDbNullable(value: Sen | undefined): bigint | null {
  return value === undefined ? null : value;
}

export function senFromDbNullable(value: unknown): Sen | undefined {
  return value === null || value === undefined ? undefined : senFromDb(value);
}

// --- provider cost ----------------------------------------------------------

export function microcentsToDb(value: Microcents): bigint {
  return value;
}

export function microcentsFromDb(value: unknown): Microcents {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `expected a bigint cost column, received ${typeof value}`,
    );
  }
  return microcents(value);
}

export function microcentsToDbNullable(
  value: Microcents | undefined,
): bigint | null {
  return value === undefined ? null : value;
}

export function microcentsFromDbNullable(value: unknown): Microcents | undefined {
  return value === null || value === undefined
    ? undefined
    : microcentsFromDb(value);
}

// --- dates ------------------------------------------------------------------

/** `IsoDate` -> `date` column. Both are `YYYY-MM-DD`; no timezone is involved,
 *  which is the reason a transaction date is a `date` and not a `timestamptz`. */
export function isoDateToDb(value: IsoDate): string {
  return value;
}

/** `date` column -> `IsoDate`, re-validated rather than trusted. */
export function isoDateFromDb(value: unknown): IsoDate {
  if (typeof value !== "string") {
    throw new TypeError(`expected a date column, received ${typeof value}`);
  }
  const parsed = isoDate(value);
  if (!parsed.ok) {
    throw new TypeError(`database returned a non-calendar date: ${value}`);
  }
  return parsed.value;
}
