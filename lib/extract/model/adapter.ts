/**
 * The model-provider port.
 *
 * `CLAUDE.md`: exactly one directory may call the model API, and this is it.
 * The rule is enforced three ways, in decreasing order of strength:
 *
 *   1. **Dependency direction.** Nothing in `lib/domain`, `lib/reconcile` or
 *      `lib/cost` imports this module; the arrows point inward only. A caller
 *      elsewhere cannot reach a provider without importing from here first.
 *   2. **The port.** Callers depend on `ModelAdapter`, never on a provider SDK,
 *      so there is no provider type to leak.
 *   3. **A structural test**, as a backstop for the day someone adds an SDK.
 *
 * **No provider SDK is installed.** `lib/storage/index.ts` set the precedent:
 * an adapter that cannot be executed without credentials "would be code nobody
 * has run pretending to be integration". A real Anthropic adapter arrives with
 * credentials and its own live verification; until then the fake exercises every
 * path deterministically and the gap is an explicit acceptance item, not a
 * silent one.
 */

import type { PricingMode } from "@/lib/cost/rates";
import type { Result } from "@/lib/domain/failures";

/** One page of input. Text or pixels — never both for the same page. */
export type ModelPageInput =
  | { readonly kind: "text"; readonly page: number; readonly text: string }
  | {
      readonly kind: "image";
      readonly page: number;
      readonly mediaType: "image/png";
      readonly bytes: Uint8Array;
    };

/**
 * A provider-neutral request.
 *
 * Carries document content, so **nothing may log it**. `lib/extract/model` has
 * no logging at all and `no-console` forbids adding any.
 */
export interface ModelRequest {
  readonly documentId: string;
  /** The stable prefix. Kept separate from pages because it is what a cache
   *  breakpoint would cover; prompt content itself is M2b. */
  readonly instructions: string;
  readonly pages: readonly ModelPageInput[];
  /** The hard cap the request will carry. Priced in full by the estimator. */
  readonly maxOutputTokens: number;
}

/**
 * Token usage as the provider reported it. **Untrusted**: a provider reporting
 * success can still return counts that are absent, fractional, negative or
 * inconsistent with the request, and any of those would corrupt the cost ledger.
 */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

export interface ModelResponse {
  /** Provider-side correlation id, where one is offered. */
  readonly requestId?: string;
  /** **Untrusted.** Deliberately `unknown`: it is not a domain value and the
   *  type system should refuse to let anyone treat it as one before validation. */
  readonly structuredOutput: unknown;
  readonly usage: ProviderUsage;
}

/** Per-call options. Separate from the request because they describe how the
 *  call is made, not what is being asked. */
export interface InvokeOptions {
  /**
   * Cancellation. Passed through to the provider's own transport so an
   * abandoned request does not leave work running and billing on the far side.
   */
  readonly signal?: AbortSignal;
}

/**
 * What a provider must offer. Two methods, because two are all the metered call
 * uses — the same discipline as the object-storage port.
 */
export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  /**
   * The commercial terms this adapter invokes under.
   *
   * Declared by the adapter because the adapter is what knows: one that submits
   * through the Batch API is billed differently from one that calls
   * synchronously, and only it can say so. Pricing looks the mode up exactly and
   * fails when the table does not cover it.
   */
  readonly pricingMode: PricingMode;
  /**
   * Counts input tokens **without invoking the model**.
   *
   * Load-bearing for non-negotiable 5: a ceiling checked against an estimated
   * token count is not a ceiling. Providers expose this as a separate, unbilled
   * endpoint.
   */
  countTokens(
    request: ModelRequest,
    options?: InvokeOptions,
  ): Promise<Result<number>>;
  invoke(
    request: ModelRequest,
    options?: InvokeOptions,
  ): Promise<Result<ModelResponse>>;
}
