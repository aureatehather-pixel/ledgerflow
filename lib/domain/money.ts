/**
 * Money, as integer sen.
 *
 * `CLAUDE.md` § Money: integer sen, never a float, **never a JS `number` for a
 * balance**. That rule is stricter than arithmetic requires -- a RM100,000,000
 * balance is 1e10 sen, comfortably inside `Number.MAX_SAFE_INTEGER` -- and the
 * reason is type-level, not numeric. TypeScript cannot distinguish an integer
 * `number` from a fractional one, so nothing stops a stray `/ 2` from
 * introducing a fraction that later rounds. `bigint` makes that impossible:
 * `1n / 2n` truncates rather than producing 0.5, and mixing a `bigint` with a
 * `number` throws at runtime instead of silently coercing.
 *
 * `Sen` is additionally branded so a byte count or a page number cannot be
 * passed where money is expected. The brand is erased at runtime; it costs
 * nothing and makes every signature in the domain self-describing.
 *
 * **Serialization for an accounting system is not here.** How a target formats
 * an amount is an M3b concern and belongs in that adapter (`CLAUDE.md` layout).
 * This module's `formatSen` exists for human display and test readability.
 */

import { fail, ok, type Result } from "./failures";

export type Sen = bigint & { readonly __sen: unique symbol };

/** Wraps a raw bigint. Use only where the value is known to be sen already. */
export function sen(value: bigint): Sen {
  return value as Sen;
}

export const ZERO: Sen = sen(0n);

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function addSen(a: Sen, b: Sen): Sen {
  return sen(a + b);
}

export function subSen(a: Sen, b: Sen): Sen {
  return sen(a - b);
}

export function negateSen(a: Sen): Sen {
  return sen(-a);
}

export function absSen(a: Sen): Sen {
  return sen(a < 0n ? -a : a);
}

export function sumSen(values: Iterable<Sen>): Sen {
  let total = 0n;
  for (const v of values) total += v;
  return sen(total);
}

/** -1, 0 or 1. `bigint` comparison is exact, so this needs no epsilon. */
export function compareSen(a: Sen, b: Sen): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isZero(a: Sen): boolean {
  return a === 0n;
}

export function isNegative(a: Sen): boolean {
  return a < 0n;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Sign conventions this parser accepts, and what they mean.
 *
 * On a Malaysian bank statement the columns are printed from the *account
 * holder's* perspective, not the bank's:
 *
 *   CR / credit  -> money in,  balance increases  -> positive
 *   DR / debit   -> money out, balance decreases  -> negative
 *   (1,234.56)   -> accounting parentheses        -> negative
 *
 * `+` and `-` mean what they look like. U+2212 MINUS SIGN is accepted because
 * PDF text extraction routinely yields it where a hyphen was printed; treating
 * it as an unknown character would fail on documents that are perfectly legible.
 *
 * Contradictory combinations are rejected rather than resolved. `(1,234.56) DR`
 * negates twice and `-1,234.56 CR` disagrees with itself; either one is a sign
 * that the token was misread, and guessing which half to believe is how a
 * credit silently becomes a debit.
 */
const CURRENCY_PREFIX = /^(?:RM|MYR)\s*/i;
const TRAILING_SUFFIX = /\s*(CR|DR)$/i;
const LEADING_SIGN = /^([+\-−])\s*/;

/**
 * The numeric core, after prefixes and signs are stripped.
 *
 * Two alternatives, both anchored: either fully grouped in threes, or no
 * grouping at all. `1,23.45` therefore fails -- it is neither -- which is the
 * point, because a misgrouped number usually means two columns ran together.
 *
 * The fraction is capped at two digits. Three would need rounding to reach sen,
 * and `CLAUDE.md` non-negotiable 3 forbids silently absorbing a difference.
 */
const NUMERIC_CORE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * Parses one monetary token into signed sen.
 *
 * **Failures never echo the input.** An amount is financial content; a malformed
 * one is still financial content. The `detail` names the defect instead, which
 * is more useful to whoever has to fix the parser anyway.
 */
export function parseAmount(raw: string): Result<Sen> {
  const original = raw.trim();
  if (original.length === 0) {
    return fail("INVALID_MONETARY_VALUE", "empty amount");
  }

  let work = original;
  let negations = 0;
  let sawCredit = false;

  // Affixes appear in either order and on either side of accounting
  // parentheses: `RM (1,234.56)`, `(1,234.56) DR` and `(RM 1,234.56 DR)` are all
  // shapes a statement can print. Rather than encode one ordering, peel whatever
  // is currently outermost until a pass changes nothing. Each peel strictly
  // shortens the string, so this terminates.
  for (;;) {
    const before = work;

    const suffix = TRAILING_SUFFIX.exec(work);
    if (suffix) {
      work = work.slice(0, suffix.index).trim();
      // `suffix[1]` is present whenever the regex matched; the fallback keeps
      // `noUncheckedIndexedAccess` satisfied without an assertion.
      if ((suffix[1] ?? "").toUpperCase() === "DR") negations += 1;
      else sawCredit = true;
    }

    work = work.replace(CURRENCY_PREFIX, "").trim();

    if (work.length >= 2 && work.startsWith("(") && work.endsWith(")")) {
      work = work.slice(1, -1).trim();
      negations += 1;
    }

    if (work === before) break;
  }

  if (work.includes("(") || work.includes(")")) {
    return fail("INVALID_MONETARY_VALUE", "unbalanced parentheses");
  }

  const signMatch = LEADING_SIGN.exec(work);
  if (signMatch) {
    work = work.slice(signMatch[0].length).trim();
    if (signMatch[1] !== "+") negations += 1;
  }

  if (negations > 1) {
    return fail(
      "INVALID_MONETARY_VALUE",
      "more than one negation (parentheses, sign and DR are mutually exclusive)",
    );
  }
  if (sawCredit && negations > 0) {
    return fail(
      "INVALID_MONETARY_VALUE",
      "CR combined with a negative marker",
    );
  }

  const core = NUMERIC_CORE.exec(work);
  if (!core) {
    return fail(
      "INVALID_MONETARY_VALUE",
      work.includes(",")
        ? "malformed digit grouping"
        : "not a decimal amount",
    );
  }

  const whole = (core[1] ?? "").replace(/,/g, "");
  const fraction = core[2];
  if (fraction !== undefined && fraction.length > 2) {
    return fail(
      "INVALID_MONETARY_VALUE",
      "more than two decimal places; sen cannot represent it without rounding",
    );
  }

  const fractionSen = BigInt((fraction ?? "").padEnd(2, "0"));
  const magnitude = BigInt(whole) * 100n + fractionSen;
  return ok(sen(negations === 1 ? -magnitude : magnitude));
}

/**
 * Parses a column amount, which is a magnitude with no direction of its own.
 *
 * Debit and credit columns carry the direction positionally, so a sign inside
 * the cell is contradictory rather than redundant.
 */
export function parseMagnitude(raw: string): Result<Sen> {
  const parsed = parseAmount(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value < 0n) {
    return fail(
      "INVALID_MONETARY_VALUE",
      "signed amount in a column whose direction is positional",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/**
 * `1234567n -> "12,345.67"`. Always two decimals, grouped in threes.
 *
 * Deterministic and locale-independent by construction: no `Intl`, no
 * `toLocaleString`. A format that changed with the host's locale would make a
 * test pass on one machine and fail on another, and would eventually put a
 * European decimal comma in front of an accountant.
 */
export function formatSen(value: Sen): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = (magnitude / 100n).toString();
  const fraction = (magnitude % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${groupThousands(whole)}.${fraction}`;
}
