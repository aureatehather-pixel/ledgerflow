/**
 * The rate table.
 *
 * **Only approved prices ship.** `PRODUCTION_RATE_TABLE` is populated under
 * `docs/decisions/0004-initial-rate-table.md` and prices exactly the models that
 * decision approved, under exactly the billing mode it was verified for. It
 * carries a version, an effective date and a source, because an undated price is
 * a number `CLAUDE.md` non-negotiable 7 forbids.
 *
 * **Everything outside that scope fails loudly. There is no fallback price and
 * no default rate.** An unpriced model, an unpriced provider, or a priced model
 * requested under terms the table does not cover all return a
 * `PROCESSING_FAILED_PERMANENT` failure rather than a guess — billing a request
 * under terms it never ran under is the silent-wrong-number class this project
 * treats as a defect.
 *
 * **Pricing a model is not choosing it.** Which model does extraction is open,
 * and until it is decided no model is assumed: nothing in the codebase selects
 * one (`docs/EXTRACTION.md` §7). The table
 * says what two models would cost, not which one runs.
 *
 * Rates are **data, not logic**. Revising them is an edit to one frozen object
 * plus a version string, recorded in a dated decision; no code changes.
 *
 * *(This block previously read "This repository ships no prices … is empty".
 * That was true at commit `a38427b` and false from `d419e85`, which approved the
 * table. Corrected 2026-07-30, together with the acceptance criterion that
 * repeated it.)*
 *
 * ## The unit, and why it is not `Sen`
 *
 * `lib/domain/money` measures a Malaysian bank statement in sen. Provider
 * billing is a different currency in a different domain, and conflating them
 * would eventually put an exchange rate — an undated number `CLAUDE.md`
 * non-negotiable 7 forbids — inside a balance calculation. Cost therefore has
 * its own branded type and never mixes with `Sen`.
 *
 * `Microcents` is 1e-6 of a currency minor unit. The unit is chosen so the
 * arithmetic needs **no division at all**:
 *
 *     price is minor units per 1,000,000 tokens
 *     cost_microcents = price x tokens
 *
 * 500 cents/MTok over 95,680 tokens is 47,840,000 microcents — exactly 47.84
 * cents, integer throughout, nothing rounded. Non-negotiable 3's prohibition on
 * silent rounding applies to money wherever it appears, not only to statements.
 */

import { fail, ok, type Result } from "@/lib/domain/failures";

/** 1e-6 of a currency minor unit (so 1e-8 of a dollar). Never mixed with `Sen`. */
export type Microcents = bigint & { readonly __microcents: unique symbol };

export function microcents(value: bigint): Microcents {
  return value as Microcents;
}

export const ZERO_COST: Microcents = microcents(0n);

export function addCost(a: Microcents, b: Microcents): Microcents {
  return microcents(a + b);
}

export type BillingCurrency = "USD";

/** Microcents in one currency minor unit (one cent). */
export const MICROCENTS_PER_MINOR_UNIT = 1_000_000n;

/**
 * Converts the published "microcents per 1,000,000 tokens" form into the minor
 * units per 1,000,000 tokens this table stores.
 *
 * The two forms describe the same quantity — a cent is 1e6 microcents and a
 * million tokens is 1e6 tokens, so the factors cancel — but they differ by 1e6
 * as integers, and writing one where the other is expected overstates a bill by
 * a factor of a million. This threw during the rate-table review, so the
 * conversion is a checked function rather than mental arithmetic.
 *
 * Throws on a non-exact conversion: silently truncating a published price is the
 * rounding non-negotiable 3 forbids, applied to the cost ledger.
 */
export function minorUnitsPerMillion(microcentsPerMillionTokens: bigint): bigint {
  if (microcentsPerMillionTokens % MICROCENTS_PER_MINOR_UNIT !== 0n) {
    throw new Error(
      `price ${microcentsPerMillionTokens} microcents/MTok is not an exact number of minor units`,
    );
  }
  return microcentsPerMillionTokens / MICROCENTS_PER_MINOR_UNIT;
}

/**
 * The commercial terms a price applies to.
 *
 * Every field is required and matched exactly at lookup. Prices differ by an
 * order of magnitude across these axes — Batch halves them, fast mode raises
 * them, partner platforms set their own — so a lookup that ignored the mode
 * would confidently price a request under terms it was never billed under.
 *
 * **`cacheWriteTtl` is pinned to `"5m"` and this is a hard invariant.**
 * `ModelRate` carries a single `cacheCreationPerMillion`, so the model
 * physically cannot distinguish a five-minute cache write from a one-hour one,
 * which are priced differently. Rather than approximate, a one-hour request has
 * no rate and fails.
 */
export interface PricingMode {
  readonly platform: "anthropic-first-party";
  readonly inference: "standard";
  readonly routing: "global";
  readonly cacheWriteTtl: "5m";
}

/** The only mode any approved rate covers. */
export const STANDARD_GLOBAL_5M: PricingMode = Object.freeze({
  platform: "anthropic-first-party",
  inference: "standard",
  routing: "global",
  cacheWriteTtl: "5m",
});

function sameMode(a: PricingMode, b: PricingMode): boolean {
  return (
    a.platform === b.platform &&
    a.inference === b.inference &&
    a.routing === b.routing &&
    a.cacheWriteTtl === b.cacheWriteTtl
  );
}

function describeMode(mode: PricingMode): string {
  return `${mode.platform}/${mode.inference}/${mode.routing}/cache-${mode.cacheWriteTtl}`;
}

/**
 * Prices for one model, in currency minor units per 1,000,000 tokens.
 *
 * All four billable classes are required rather than optional. An optional
 * cache rate would default to zero, and a cache class silently priced at zero is
 * a ceiling that does not bind — exactly the failure non-negotiable 5 exists to
 * prevent.
 */
export interface ModelRate {
  readonly provider: string;
  readonly model: string;
  /** The commercial terms these prices apply to. Matched exactly at lookup. */
  readonly mode: PricingMode;
  readonly currency: BillingCurrency;
  /** Currency **minor units** (cents) per 1,000,000 tokens — NOT microcents.
   *  Build with `minorUnitsPerMillion` rather than by hand. */
  readonly inputPerMillion: bigint;
  readonly outputPerMillion: bigint;
  /** Five-minute cache write only; see `PricingMode.cacheWriteTtl`. */
  readonly cacheCreationPerMillion: bigint;
  readonly cacheReadPerMillion: bigint;
}

export interface RateTable {
  /** Recorded against every calculation so a historical cost stays explicable
   *  after prices change. */
  readonly version: string;
  /** ISO-8601 date the rates take effect. */
  readonly effectiveFrom: string;
  /** Where the numbers came from. Non-negotiable 7: an undated figure is a bug. */
  readonly source: string;
  readonly rates: readonly ModelRate[];
}

/**
 * The approved production rates.
 *
 * Approved 2026-07-29 against official Anthropic pricing documentation; scope,
 * exclusions and reconsideration triggers are in
 * `docs/decisions/0004-initial-rate-table.md`.
 *
 * **Supporting a model here is not approving it for extraction.** Which model
 * does the work remains open (`docs/EXTRACTION.md` §7) and is decided by measured
 * accuracy and cost against real statements, not by what happens to be priced.
 *
 * Prices are written in the published microcents-per-million form and converted
 * once, checked, so the ADR and this table can be compared line by line.
 */
export const PRODUCTION_RATE_TABLE: RateTable = Object.freeze({
  version: "anthropic-global-standard-2026-07-29.1",
  effectiveFrom: "2026-07-29",
  source:
    "Official Anthropic Claude Platform pricing documentation, verified 2026-07-29. Scope: first-party API, synchronous standard inference, global routing, 5-minute cache writes and cache reads. See docs/decisions/0004.",
  rates: Object.freeze([
    Object.freeze({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      mode: STANDARD_GLOBAL_5M,
      currency: "USD" as const,
      inputPerMillion: minorUnitsPerMillion(100_000_000n), // $1.00
      cacheCreationPerMillion: minorUnitsPerMillion(125_000_000n), // $1.25
      cacheReadPerMillion: minorUnitsPerMillion(10_000_000n), // $0.10
      outputPerMillion: minorUnitsPerMillion(500_000_000n), // $5.00
    }),
    Object.freeze({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      mode: STANDARD_GLOBAL_5M,
      currency: "USD" as const,
      inputPerMillion: minorUnitsPerMillion(300_000_000n), // $3.00
      cacheCreationPerMillion: minorUnitsPerMillion(375_000_000n), // $3.75
      cacheReadPerMillion: minorUnitsPerMillion(30_000_000n), // $0.30
      outputPerMillion: minorUnitsPerMillion(1_500_000_000n), // $15.00
    }),
  ]),
});

/**
 * Finds a rate for a model **under a specific pricing mode**, or fails.
 *
 * The mode is not optional and is not defaulted. Batch, fast mode, US-only
 * routing, a partner platform and a one-hour cache write are all priced
 * differently, and defaulting to standard global terms would silently bill a
 * request under terms it was never charged under.
 *
 * `PROCESSING_FAILED_PERMANENT` rather than a retryable kind: another attempt
 * with the same configuration fails identically. Only a configuration or
 * rate-table change fixes it, and that is a human decision.
 */
export function lookupRate(
  table: RateTable,
  provider: string,
  model: string,
  mode: PricingMode,
): Result<ModelRate> {
  const forModel = table.rates.filter(
    (r) => r.provider === provider && r.model === model,
  );
  if (forModel.length === 0) {
    return fail(
      "PROCESSING_FAILED_PERMANENT",
      `no rate for ${provider}/${model} in rate table ${table.version}; cost cannot be computed`,
    );
  }

  const found = forModel.find((r) => sameMode(r.mode, mode));
  if (!found) {
    return fail(
      "PROCESSING_FAILED_PERMANENT",
      `rate table ${table.version} prices ${provider}/${model} but not under ${describeMode(mode)}`,
    );
  }
  return ok(found);
}

/** Token counts per billable class. Integers, never negative. */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

export const NO_TOKENS: TokenCounts = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

/**
 * Prices a set of token counts exactly.
 *
 * Multiplication only — no division, so nothing rounds. Counts are validated as
 * non-negative integers because a float token count would silently truncate
 * inside `BigInt()` and a negative one would credit the ceiling.
 */
export function priceTokens(
  rate: ModelRate,
  counts: TokenCounts,
): Result<Microcents> {
  const entries: readonly [string, number, bigint][] = [
    ["inputTokens", counts.inputTokens, rate.inputPerMillion],
    ["outputTokens", counts.outputTokens, rate.outputPerMillion],
    [
      "cacheCreationTokens",
      counts.cacheCreationTokens,
      rate.cacheCreationPerMillion,
    ],
    ["cacheReadTokens", counts.cacheReadTokens, rate.cacheReadPerMillion],
  ];

  let total = 0n;
  for (const [name, count, perMillion] of entries) {
    if (!Number.isInteger(count) || count < 0) {
      return fail(
        "PROCESSING_FAILED_PERMANENT",
        `${name} must be a non-negative integer`,
      );
    }
    total += BigInt(count) * perMillion;
  }
  return ok(microcents(total));
}

/** `4784000000n -> "47.8400"` cents. Display only; never used in arithmetic. */
export function formatMicrocents(value: Microcents): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000n;
  const fraction = (magnitude % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
