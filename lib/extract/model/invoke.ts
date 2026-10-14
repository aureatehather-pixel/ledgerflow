/**
 * The metered call: the one production path that reaches a model provider.
 *
 *     count tokens -> estimate worst case -> enforce ceiling -> invoke
 *       -> validate usage -> validate output -> price the actual usage
 *
 * The order is the requirement. Nothing reaches the provider before the ceiling
 * has passed, and `meteredInvoke` is the only function that calls
 * `adapter.invoke`.
 *
 * **This is not orchestration.** No retries, no scheduling, no persistence, no
 * fallback to another model. One call, priced and recorded. Retry policy and job
 * state live in `lib/extract/orchestration`, and the record produced here is
 * what `saveProviderCall` stores.
 *
 * **Nothing here logs.** The request carries statement content and the response
 * carries extracted transactions; the record deliberately holds counts, costs,
 * identifiers and an outcome, and never the payload on either side.
 */

import {
  publicFailure,
  type Failure,
  type PublicFailure,
} from "@/lib/domain/failures";
import type { StatementDraft } from "@/lib/domain/statement";

import {
  enforceCeiling,
  estimateWorstCase,
  type CostCeiling,
} from "@/lib/cost/ceiling";
import {
  priceTokens,
  lookupRate,
  type BillingCurrency,
  type Microcents,
  type RateTable,
  type TokenCounts,
} from "@/lib/cost/rates";

import type { InvokeOptions, ModelAdapter, ModelRequest } from "./adapter";
import { toStatementDraft, validateUsage, type TransformContext } from "./schema";

/**
 * How a call ended. Four states, kept distinct because they need different
 * responses: a refusal costs nothing and needs configuration; a provider failure
 * may be worth retrying; malformed output was **billed** and is not; success
 * still has to pass reconciliation afterwards.
 */
export type ModelCallOutcome =
  | "rejected-before-invocation"
  | "provider-invocation-failed"
  | "provider-output-malformed"
  | "succeeded";

export interface ModelCallRecord {
  readonly documentId: string;
  readonly provider: string;
  readonly model: string;
  readonly rateTableVersion: string;
  readonly currency: BillingCurrency;
  readonly requestId?: string;
  readonly estimatedMaximumCost?: Microcents;
  /** Present whenever usage was valid — including on malformed output, because
   *  a provider that returns garbage still bills for it. */
  readonly actualCost?: Microcents;
  readonly usage?: TokenCounts;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ModelCallOutcome;
  /** Cause-free by construction: `publicFailure` strips it. */
  readonly failure?: PublicFailure;
}

export interface MeteredInvokeResult {
  readonly record: ModelCallRecord;
  /** Present only on success. A draft — the reconciliation gate still applies. */
  readonly draft?: StatementDraft;
}

export interface MeteredInvokeDeps {
  readonly adapter: ModelAdapter;
  readonly rateTable: RateTable;
  readonly ceiling: CostCeiling;
  /** Injected so records are deterministic under test. */
  readonly now: () => Date;
}

export async function meteredInvoke(
  deps: MeteredInvokeDeps,
  request: ModelRequest,
  transform: TransformContext,
  options: InvokeOptions = {},
): Promise<MeteredInvokeResult> {
  const { adapter, rateTable, ceiling, now } = deps;
  const startedAt = now().toISOString();

  const base = {
    documentId: request.documentId,
    provider: adapter.provider,
    model: adapter.model,
    rateTableVersion: rateTable.version,
  } as const;

  // The rate is resolved first so the currency is known even on refusal paths.
  const rate = lookupRate(
    rateTable,
    adapter.provider,
    adapter.model,
    adapter.pricingMode,
  );
  const currency: BillingCurrency = rate.ok ? rate.value.currency : "USD";

  const reject = (
    outcome: ModelCallOutcome,
    failure: Failure,
    extra: Partial<ModelCallRecord> = {},
  ): MeteredInvokeResult => ({
    record: {
      ...base,
      currency,
      startedAt,
      completedAt: now().toISOString(),
      outcome,
      failure: publicFailure(failure),
      ...extra,
    },
  });

  // --- before the provider is touched -------------------------------------

  const counted = await adapter.countTokens(request, options);
  if (!counted.ok) {
    return reject("rejected-before-invocation", counted.failure);
  }

  const estimate = estimateWorstCase(rateTable, {
    provider: adapter.provider,
    model: adapter.model,
    mode: adapter.pricingMode,
    inputTokens: counted.value,
    maxOutputTokens: request.maxOutputTokens,
  });
  if (!estimate.ok) {
    return reject("rejected-before-invocation", estimate.failure);
  }

  const allowed = enforceCeiling(estimate.value, ceiling);
  if (!allowed.ok) {
    // Refused. No clamping, no cheaper model, no shorter request: the call
    // simply does not happen.
    return reject("rejected-before-invocation", allowed.failure, {
      estimatedMaximumCost: estimate.value.maximumCost,
    });
  }

  const estimatedMaximumCost = estimate.value.maximumCost;

  // --- the provider --------------------------------------------------------

  const response = await adapter.invoke(request, options);
  if (!response.ok) {
    return reject("provider-invocation-failed", response.failure, {
      estimatedMaximumCost,
    });
  }

  const requestIdPart =
    response.value.requestId === undefined
      ? {}
      : { requestId: response.value.requestId };

  const usage = validateUsage(response.value.usage, request);
  if (!usage.ok) {
    return reject("provider-output-malformed", usage.failure, {
      estimatedMaximumCost,
      ...requestIdPart,
    });
  }

  const counts: TokenCounts = usage.value;
  const actual = rate.ok ? priceTokens(rate.value, counts) : undefined;
  const actualCostPart =
    actual !== undefined && actual.ok ? { actualCost: actual.value } : {};

  const draft = toStatementDraft(response.value.structuredOutput, transform);
  if (!draft.ok) {
    // Billed anyway. Recording the cost here is the difference between a ledger
    // that reconciles with the provider's invoice and one that does not.
    return reject("provider-output-malformed", draft.failure, {
      estimatedMaximumCost,
      usage: counts,
      ...actualCostPart,
      ...requestIdPart,
    });
  }

  return {
    record: {
      ...base,
      currency,
      startedAt,
      completedAt: now().toISOString(),
      outcome: "succeeded",
      estimatedMaximumCost,
      usage: counts,
      ...actualCostPart,
      ...requestIdPart,
    },
    draft: draft.value,
  };
}
