/**
 * Pre-call estimation and the **per-call** spend ceiling.
 *
 * `CLAUDE.md` non-negotiable 5: the ceiling is checked **before** the call and
 * **fails loud**. That is only honest if a call can be priced before it is made,
 * which is why `ModelAdapter.countTokens` exists — an estimate built from a
 * guess is not a ceiling.
 *
 * **What this module does NOT implement.** Non-negotiable 5 requires a
 * **monthly** ceiling. This is a per-call one. Nothing here or anywhere else
 * aggregates `provider_calls` over a period, so a budget can be exhausted by
 * many individually-permitted calls without anything refusing. Do not read the
 * checks below as satisfying the non-negotiable in full — they satisfy half of
 * it. `docs/EXTRACTION.md` §7 item 13 carries the gap and its consequences.
 *
 * Output tokens cannot be known in advance, so the estimate prices the full
 * `maxOutputTokens` the request permits. That is the conservative direction: the
 * estimate can only ever exceed the actual bill, never understate it.
 *
 * **The ceiling never adapts.** It does not clamp `max_tokens`, drop cache
 * usage, shorten the request, or reach for a cheaper model. Any of those would
 * silently change what was asked for in order to stay under budget, and a
 * quietly downgraded extraction is worse than a refused one: it produces a
 * confident answer from a request nobody approved. Choosing a cheaper model is
 * the operator's decision, made deliberately (`docs/EXTRACTION.md` §7).
 */

import { fail, ok, type Result } from "@/lib/domain/failures";

import {
  formatMicrocents,
  lookupRate,
  priceTokens,
  type BillingCurrency,
  type Microcents,
  type PricingMode,
  type RateTable,
  type TokenCounts,
} from "./rates";

/**
 * The budget, supplied by the caller.
 *
 * Injected rather than a module constant so a test can prove rejection without
 * editing production configuration, and so the value lives with deployment
 * configuration where it belongs.
 */
export interface CostCeiling {
  /**
   * The most a *single* call may cost. There is deliberately no monthly field:
   * a cumulative ceiling needs a query over `provider_calls`, not another
   * number here, and adding a field without that query would look like the
   * monthly ceiling exists. See `docs/EXTRACTION.md` §7 item 13.
   */
  readonly perCallMicrocents: bigint;
  readonly currency: BillingCurrency;
}

export interface EstimateRequest {
  readonly provider: string;
  readonly model: string;
  /** Commercial terms. Required: no mode is defaulted. */
  readonly mode: PricingMode;
  /** Measured, not guessed — from the provider's own token counter. */
  readonly inputTokens: number;
  /** The cap the request will carry. Priced in full. */
  readonly maxOutputTokens: number;
  /** Tokens expected to be written to cache on this call. */
  readonly cacheCreationTokens?: number;
  /** Tokens expected to be served from cache on this call. */
  readonly cacheReadTokens?: number;
}

export interface CostEstimate {
  readonly provider: string;
  readonly model: string;
  readonly mode: PricingMode;
  readonly rateTableVersion: string;
  /** Recorded so a historical cost stays explicable after prices change. */
  readonly rateEffectiveFrom: string;
  readonly currency: BillingCurrency;
  readonly counts: TokenCounts;
  readonly maximumCost: Microcents;
}

/**
 * Prices the worst case this request could bill.
 *
 * Cache classes are supplied by the caller because only the caller knows which
 * part of its prompt is cacheable. Note the conservative reading: a prefix you
 * *expect* to be read from cache should be declared as `cacheCreationTokens` when
 * you cannot be sure of a hit, since a write costs more than a read.
 */
export function estimateWorstCase(
  table: RateTable,
  request: EstimateRequest,
): Result<CostEstimate> {
  const rate = lookupRate(table, request.provider, request.model, request.mode);
  if (!rate.ok) return rate;

  const counts: TokenCounts = {
    inputTokens: request.inputTokens,
    outputTokens: request.maxOutputTokens,
    cacheCreationTokens: request.cacheCreationTokens ?? 0,
    cacheReadTokens: request.cacheReadTokens ?? 0,
  };

  const priced = priceTokens(rate.value, counts);
  if (!priced.ok) return priced;

  return ok({
    provider: request.provider,
    model: request.model,
    mode: request.mode,
    rateTableVersion: table.version,
    rateEffectiveFrom: table.effectiveFrom,
    currency: rate.value.currency,
    counts,
    maximumCost: priced.value,
  });
}

/**
 * The gate. Returns the estimate unchanged, or refuses.
 *
 * A currency mismatch is a failure rather than a conversion: converting would
 * need an exchange rate, and an undated exchange rate inside a budget check is
 * precisely the class of number non-negotiable 7 rejects.
 */
export function enforceCeiling(
  estimate: CostEstimate,
  ceiling: CostCeiling,
): Result<CostEstimate> {
  if (estimate.currency !== ceiling.currency) {
    return fail(
      "COST_CEILING_EXCEEDED",
      `ceiling is in ${ceiling.currency} but the rate is in ${estimate.currency}; no conversion is applied`,
    );
  }
  if (estimate.maximumCost > ceiling.perCallMicrocents) {
    return fail(
      "COST_CEILING_EXCEEDED",
      `estimated maximum ${formatMicrocents(estimate.maximumCost)} exceeds the per-call ceiling of ${formatMicrocents(
        ceiling.perCallMicrocents as Microcents,
      )} (${estimate.currency} cents, rate table ${estimate.rateTableVersion})`,
    );
  }
  return ok(estimate);
}
