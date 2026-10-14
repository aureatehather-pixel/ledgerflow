import { describe, expect, it } from "vitest";

import { enforceCeiling, estimateWorstCase, type CostCeiling } from "./ceiling";
import {
  MICROCENTS_PER_MINOR_UNIT,
  NO_TOKENS,
  PRODUCTION_RATE_TABLE,
  STANDARD_GLOBAL_5M,
  formatMicrocents,
  lookupRate,
  microcents,
  minorUnitsPerMillion,
  priceTokens,
  type PricingMode,
} from "./rates";
import { FAKE_RATE, FAKE_RATE_TABLE, FAKE_RATE_TABLE_V2 } from "./testing";

const CEILING: CostCeiling = { perCallMicrocents: 10_000_000n, currency: "USD" };

/** Modes outside the approved scope. Cast because the type pins the approved
 *  literals — the point is to prove the *runtime* guard, not the type. */
const UNSUPPORTED_MODES: readonly (readonly [string, PricingMode])[] = [
  ["Batch API", { ...STANDARD_GLOBAL_5M, inference: "batch" } as unknown as PricingMode],
  ["fast mode", { ...STANDARD_GLOBAL_5M, inference: "fast" } as unknown as PricingMode],
  ["US-only routing", { ...STANDARD_GLOBAL_5M, routing: "us-only" } as unknown as PricingMode],
  ["one-hour cache", { ...STANDARD_GLOBAL_5M, cacheWriteTtl: "1h" } as unknown as PricingMode],
  ["Bedrock", { ...STANDARD_GLOBAL_5M, platform: "aws-bedrock" } as unknown as PricingMode],
];

// ---------------------------------------------------------------------------
// The approved rate table
// ---------------------------------------------------------------------------

describe("the approved rate table", () => {
  it("records its version, effective date and source", () => {
    expect(PRODUCTION_RATE_TABLE.version).toBe(
      "anthropic-global-standard-2026-07-29.1",
    );
    expect(PRODUCTION_RATE_TABLE.effectiveFrom).toBe("2026-07-29");
    expect(PRODUCTION_RATE_TABLE.source).toContain("verified 2026-07-29");
  });

  it("covers exactly the two approved models", () => {
    expect(PRODUCTION_RATE_TABLE.rates.map((r) => r.model).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
  });

  /**
   * The published figures, in the microcents-per-million form they were
   * approved in. Stored as minor units per million, which is the same quantity
   * a million times smaller as an integer — the conversion that had to be
   * verified before these were applied.
   */
  it.each([
    ["claude-haiku-4-5", 100_000_000n, 125_000_000n, 10_000_000n, 500_000_000n],
    ["claude-sonnet-4-6", 300_000_000n, 375_000_000n, 30_000_000n, 1_500_000_000n],
  ])("prices %s exactly as approved", (model, input, cacheWrite, cacheRead, output) => {
    const r = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", model, STANDARD_GLOBAL_5M);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.inputPerMillion).toBe(input / MICROCENTS_PER_MINOR_UNIT);
    expect(r.value.cacheCreationPerMillion).toBe(cacheWrite / MICROCENTS_PER_MINOR_UNIT);
    expect(r.value.cacheReadPerMillion).toBe(cacheRead / MICROCENTS_PER_MINOR_UNIT);
    expect(r.value.outputPerMillion).toBe(output / MICROCENTS_PER_MINOR_UNIT);
    expect(r.value.currency).toBe("USD");
  });

  it("bills one million input tokens at exactly the published price", () => {
    // The clearest possible statement of the unit: $1.00 for Haiku, $3.00 for
    // Sonnet, expressed in microcents.
    for (const [model, expected] of [
      ["claude-haiku-4-5", 100_000_000n],
      ["claude-sonnet-4-6", 300_000_000n],
    ] as const) {
      const rate = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", model, STANDARD_GLOBAL_5M);
      expect(rate.ok).toBe(true);
      if (!rate.ok) continue;
      const priced = priceTokens(rate.value, { ...NO_TOKENS, inputTokens: 1_000_000 });
      expect(priced.ok && priced.value).toBe(expected);
    }
  });

  it("bills a single token exactly, with no rounding", () => {
    const rate = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", "claude-sonnet-4-6", STANDARD_GLOBAL_5M);
    expect(rate.ok).toBe(true);
    if (!rate.ok) return;
    // $3.00/MTok is 300 microcents per token.
    expect(priceTokens(rate.value, { ...NO_TOKENS, inputTokens: 1 }).ok).toBe(true);
    const one = priceTokens(rate.value, { ...NO_TOKENS, inputTokens: 1 });
    expect(one.ok && one.value).toBe(300n);
    const million = priceTokens(rate.value, { ...NO_TOKENS, inputTokens: 1_000_000 });
    expect(million.ok && million.value).toBe(300n * 1_000_000n);
  });

  it("supporting a model is not approving it for extraction", () => {
    // The model choice is open (docs/EXTRACTION.md §7); pricing two models does not
    // decide it. Nothing in the codebase selects one.
    expect(PRODUCTION_RATE_TABLE.rates).toHaveLength(2);
  });
});

describe("the unit conversion that had to be checked", () => {
  it("converts published microcents-per-million to stored minor units", () => {
    expect(minorUnitsPerMillion(100_000_000n)).toBe(100n); // $1.00
    expect(minorUnitsPerMillion(1_500_000_000n)).toBe(1_500n); // $15.00
  });

  it("throws rather than truncating a non-exact price", () => {
    // Silently rounding a published price is the rounding non-negotiable 3
    // forbids, applied to the cost ledger.
    expect(() => minorUnitsPerMillion(100_000_001n)).toThrow(/not an exact/);
  });
});

// ---------------------------------------------------------------------------
// Loud failure outside the approved scope
// ---------------------------------------------------------------------------

describe("unsupported lookups fail loudly", () => {
  it.each(["claude-opus-5", "claude-fable-5", "gpt-4", "claude-haiku-3"])(
    "rejects unpriced model %s",
    (model) => {
      const r = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", model, STANDARD_GLOBAL_5M);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.kind).toBe("PROCESSING_FAILED_PERMANENT");
        expect(r.failure.detail).toContain("no rate for");
      }
    },
  );

  it("rejects an unpriced provider", () => {
    const r = lookupRate(PRODUCTION_RATE_TABLE, "aws", "claude-haiku-4-5", STANDARD_GLOBAL_5M);
    expect(r.ok).toBe(false);
  });

  it.each(UNSUPPORTED_MODES)("rejects %s for an otherwise priced model", (_label, mode) => {
    // The model IS in the table; the terms are not. A default to standard
    // global pricing here would bill a request under terms it never ran under.
    const r = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", "claude-haiku-4-5", mode);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("PROCESSING_FAILED_PERMANENT");
      expect(r.failure.detail).toContain("but not under");
    }
  });

  it("applies no accidental Batch discount", () => {
    // Batch halves token cost, and the table does not cover it. The engine must
    // refuse rather than quietly charge the standard rate — or half of it.
    const batch = { ...STANDARD_GLOBAL_5M, inference: "batch" } as unknown as PricingMode;
    const standard = lookupRate(PRODUCTION_RATE_TABLE, "anthropic", "claude-haiku-4-5", STANDARD_GLOBAL_5M);
    expect(standard.ok).toBe(true);
    expect(lookupRate(PRODUCTION_RATE_TABLE, "anthropic", "claude-haiku-4-5", batch).ok).toBe(false);
  });

  it("applies no accidental data-residency multiplier", () => {
    const usOnly = { ...STANDARD_GLOBAL_5M, routing: "us-only" } as unknown as PricingMode;
    expect(lookupRate(PRODUCTION_RATE_TABLE, "anthropic", "claude-sonnet-4-6", usOnly).ok).toBe(false);
  });

  it("supports only five-minute cache writes, as a stated invariant", () => {
    // ModelRate carries ONE cacheCreationPerMillion, so it physically cannot
    // distinguish a 5-minute write from a 1-hour one. Rather than approximate,
    // a one-hour request has no rate.
    const oneHour = { ...STANDARD_GLOBAL_5M, cacheWriteTtl: "1h" } as unknown as PricingMode;
    for (const model of ["claude-haiku-4-5", "claude-sonnet-4-6"]) {
      expect(lookupRate(PRODUCTION_RATE_TABLE, "anthropic", model, oneHour).ok).toBe(false);
    }
    expect(STANDARD_GLOBAL_5M.cacheWriteTtl).toBe("5m");
  });
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe("pricing is exact integer arithmetic", () => {
  it("prices each class by multiplication alone", () => {
    const r = priceTokens(FAKE_RATE, { ...NO_TOKENS, inputTokens: 1_000 });
    expect(r.ok && r.value).toBe(100_000n);
  });

  it("sums every billable class", () => {
    const r = priceTokens(FAKE_RATE, {
      inputTokens: 1_000, // 100,000
      outputTokens: 2_000, // 1,000,000
      cacheCreationTokens: 4_000, // 500,000
      cacheReadTokens: 8_000, // 80,000
    });
    expect(r.ok && r.value).toBe(1_680_000n);
  });

  it("never rounds, at any magnitude", () => {
    const r = priceTokens(FAKE_RATE, { ...NO_TOKENS, inputTokens: 9_007_199_254 });
    expect(r.ok && r.value).toBe(900_719_925_400n);
  });

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s token count", (_label, inputTokens) => {
    const r = priceTokens(FAKE_RATE, { ...NO_TOKENS, inputTokens });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("non-negative integer");
  });

  it("formats for display without being used in arithmetic", () => {
    expect(formatMicrocents(microcents(47_840_000n))).toBe("47.840000");
    expect(formatMicrocents(microcents(0n))).toBe("0.000000");
  });
});

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

describe("worst-case estimation", () => {
  const base = {
    provider: "fake",
    model: "fake-model-1",
    mode: STANDARD_GLOBAL_5M,
  } as const;

  it("prices the full output cap, because actual output is unknowable", () => {
    const r = estimateWorstCase(FAKE_RATE_TABLE, {
      ...base,
      inputTokens: 1_000,
      maxOutputTokens: 2_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.counts.outputTokens).toBe(2_000);
      expect(r.value.maximumCost).toBe(1_100_000n);
    }
  });

  it("includes cache classes when the caller declares them", () => {
    const r = estimateWorstCase(FAKE_RATE_TABLE, {
      ...base,
      inputTokens: 0,
      maxOutputTokens: 0,
      cacheCreationTokens: 8_000,
      cacheReadTokens: 1_000,
    });
    expect(r.ok && r.value.maximumCost).toBe(1_010_000n);
  });

  it("fails when the model has no rate", () => {
    const r = estimateWorstCase(FAKE_RATE_TABLE, {
      ...base,
      model: "not-in-the-table",
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("fails when the mode is outside the table", () => {
    const r = estimateWorstCase(FAKE_RATE_TABLE, {
      ...base,
      mode: { ...STANDARD_GLOBAL_5M, inference: "batch" } as unknown as PricingMode,
      inputTokens: 1,
      maxOutputTokens: 1,
    });
    expect(r.ok).toBe(false);
  });
});

describe("historical calculations survive a rate change", () => {
  const request = {
    provider: "fake",
    model: "fake-model-1",
    mode: STANDARD_GLOBAL_5M,
    inputTokens: 1_000,
    maxOutputTokens: 0,
  } as const;

  it("stamps each estimate with the version and effective date used", () => {
    const one = estimateWorstCase(FAKE_RATE_TABLE, request);
    const two = estimateWorstCase(FAKE_RATE_TABLE_V2, request);

    expect(one.ok && one.value.rateTableVersion).toBe("test-fixture-v1");
    expect(one.ok && one.value.rateEffectiveFrom).toBe("2026-01-01");
    expect(two.ok && two.value.rateTableVersion).toBe("test-fixture-v2");
    expect(two.ok && two.value.rateEffectiveFrom).toBe("2026-06-01");
  });

  it("does not retroactively reprice an earlier estimate", () => {
    // The historical record is the estimate object plus the version stamped on
    // it. Publishing v2 changes what NEW calls cost and nothing about old ones.
    const historical = estimateWorstCase(FAKE_RATE_TABLE, request);
    expect(historical.ok && historical.value.maximumCost).toBe(100_000n);

    const current = estimateWorstCase(FAKE_RATE_TABLE_V2, request);
    expect(current.ok && current.value.maximumCost).toBe(200_000n);

    // Re-read after the newer table exists: unchanged.
    expect(historical.ok && historical.value.maximumCost).toBe(100_000n);
    expect(historical.ok && historical.value.rateTableVersion).toBe("test-fixture-v1");
  });
});

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

describe("the ceiling", () => {
  function estimate(inputTokens: number) {
    const r = estimateWorstCase(FAKE_RATE_TABLE, {
      provider: "fake",
      model: "fake-model-1",
      mode: STANDARD_GLOBAL_5M,
      inputTokens,
      maxOutputTokens: 0,
    });
    if (!r.ok) throw new Error("estimate failed");
    return r.value;
  }

  it("allows a request inside the budget", () => {
    expect(enforceCeiling(estimate(1_000), CEILING).ok).toBe(true);
  });

  it("allows a request exactly at the budget", () => {
    expect(enforceCeiling(estimate(100_000), CEILING).ok).toBe(true);
  });

  it("refuses one microcent over", () => {
    const r = enforceCeiling(estimate(100_001), CEILING);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("COST_CEILING_EXCEEDED");
      expect(r.failure.detail).toContain("exceeds the per-call ceiling");
    }
  });

  it("refuses rather than converting across currencies", () => {
    const r = enforceCeiling(estimate(1), {
      perCallMicrocents: 10n ** 12n,
      currency: "MYR" as unknown as "USD",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("no conversion is applied");
  });

  it("is injected, not a module constant", () => {
    const tight: CostCeiling = { perCallMicrocents: 1n, currency: "USD" };
    expect(enforceCeiling(estimate(1_000), CEILING).ok).toBe(true);
    expect(enforceCeiling(estimate(1_000), tight).ok).toBe(false);
  });
});
