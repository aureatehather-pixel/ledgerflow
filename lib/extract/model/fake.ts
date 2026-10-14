/**
 * A scripted, deterministic model adapter.
 *
 * Exercises every branch of the metered call without a network, a key or a bill.
 * It counts its own invocations, which is how "a ceiling rejection makes zero
 * provider calls" is proved rather than asserted.
 *
 * Lives beside the port rather than in a test file so several test files can
 * share it, and is never exported from an index — nothing can wire it into a
 * production path by mistake.
 */

import { STANDARD_GLOBAL_5M, type PricingMode } from "@/lib/cost/rates";
import { fail, ok, type Result } from "@/lib/domain/failures";

import type {
  InvokeOptions,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ProviderUsage,
} from "./adapter";
import type { RawStatementOutput } from "./schema";

export interface FakeScript {
  readonly provider?: string;
  readonly model?: string;
  readonly pricingMode?: PricingMode;
  /** Input tokens to report. A failure here rejects before invocation. */
  readonly countTokens?: number | "fail";
  /** `"fail"` simulates the provider itself erroring. */
  readonly invoke?: "fail";
  /** Body returned as `structuredOutput`. Anything is allowed — the point is
   *  that a caller must validate it. */
  readonly structuredOutput?: unknown;
  /** Usage exactly as reported, including deliberately invalid shapes. */
  readonly usage?: unknown;
  readonly requestId?: string;
}

export interface FakeModelAdapter extends ModelAdapter {
  /** Provider invocations. Zero is a meaningful assertion. */
  readonly invocations: () => number;
  readonly tokenCounts: () => number;
  readonly lastRequest: () => ModelRequest | undefined;
}

const DEFAULT_USAGE: ProviderUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/** A minimal, well-formed provider payload. Not a bank layout. */
export function wellFormedOutput(
  overrides: Partial<RawStatementOutput> = {},
): RawStatementOutput {
  return {
    accountReference: "SAMPLEBANK 0000000000",
    currency: "MYR",
    // Month-name form on purpose. `01/07/2026` is ambiguous under DD/MM vs
    // MM/DD and the date parser refuses it -- which it did to an earlier
    // version of this fixture. A "well-formed" payload has to be well-formed by
    // the domain's standard, not by the one that was convenient to type.
    periodStart: "01 JUL 2026",
    periodEnd: "31 JUL 2026",
    openingBalance: "1,000.00",
    closingBalance: "1,150.00",
    lines: [
      {
        date: "14/07/2026",
        description: "SYNTHETIC CREDIT",
        debit: "",
        credit: "200.00",
        page: 1,
      },
      {
        date: "15/07/2026",
        description: "SYNTHETIC DEBIT",
        debit: "50.00",
        credit: "",
        page: 1,
      },
    ],
    ...overrides,
  };
}

export function createFakeModelAdapter(script: FakeScript = {}): FakeModelAdapter {
  let invocations = 0;
  let tokenCounts = 0;
  let lastRequest: ModelRequest | undefined;

  return {
    provider: script.provider ?? "fake",
    model: script.model ?? "fake-model-1",
    pricingMode: script.pricingMode ?? STANDARD_GLOBAL_5M,

    async countTokens(
      request: ModelRequest,
      options?: InvokeOptions,
    ): Promise<Result<number>> {
      tokenCounts += 1;
      lastRequest = request;
      if (options?.signal?.aborted) {
        return fail("PROVIDER_FAILED", "cancelled before counting tokens");
      }
      if (script.countTokens === "fail") {
        return fail("PROVIDER_FAILED", "token counting is unavailable");
      }
      return ok(script.countTokens ?? 1_000);
    },

    async invoke(
      request: ModelRequest,
      options?: InvokeOptions,
    ): Promise<Result<ModelResponse>> {
      invocations += 1;
      lastRequest = request;
      if (options?.signal?.aborted) {
        return fail("PROVIDER_FAILED", "cancelled before the provider replied");
      }
      if (script.invoke === "fail") {
        return fail("PROVIDER_FAILED", "the provider returned an error");
      }
      return ok<ModelResponse>({
        structuredOutput:
          "structuredOutput" in script ? script.structuredOutput : wellFormedOutput(),
        usage: (("usage" in script ? script.usage : DEFAULT_USAGE) ??
          DEFAULT_USAGE) as ProviderUsage,
        ...(script.requestId === undefined ? {} : { requestId: script.requestId }),
      });
    },

    invocations: () => invocations,
    tokenCounts: () => tokenCounts,
    lastRequest: () => lastRequest,
  };
}
