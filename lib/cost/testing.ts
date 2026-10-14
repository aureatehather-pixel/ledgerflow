/**
 * A rate table for tests.
 *
 * **These are not prices.** They are arbitrary round numbers attached to a
 * provider literally named `fake`, chosen so expected costs can be checked by
 * hand.
 *
 * They exist so the cost engine's arithmetic, ceiling and versioning can be
 * exercised without depending on the approved production rates. The real table
 * (`PRODUCTION_RATE_TABLE`) is tested separately and directly, against the
 * figures in `docs/decisions/0004-initial-rate-table.md`.
 */

import { STANDARD_GLOBAL_5M, type ModelRate, type RateTable } from "./rates";

/** Round numbers: 1000 input tokens cost exactly 100,000 microcents. */
export const FAKE_RATE: ModelRate = Object.freeze({
  provider: "fake",
  model: "fake-model-1",
  mode: STANDARD_GLOBAL_5M,
  currency: "USD",
  inputPerMillion: 100n,
  outputPerMillion: 500n,
  cacheCreationPerMillion: 125n,
  cacheReadPerMillion: 10n,
});

export const FAKE_RATE_TABLE: RateTable = Object.freeze({
  version: "test-fixture-v1",
  effectiveFrom: "2026-01-01",
  source: "Arbitrary values for tests. Not any provider's pricing.",
  rates: Object.freeze([FAKE_RATE]),
});

/** A second table, to prove the version travels with each calculation. */
export const FAKE_RATE_TABLE_V2: RateTable = Object.freeze({
  version: "test-fixture-v2",
  effectiveFrom: "2026-06-01",
  source: "Arbitrary values for tests. Not any provider's pricing.",
  rates: Object.freeze([
    { ...FAKE_RATE, inputPerMillion: 200n, outputPerMillion: 1000n },
  ]),
});

/** A clock that advances one second per read, so records are deterministic. */
export function fixedClock(startIso = "2026-07-29T12:00:00.000Z"): () => Date {
  let tick = 0;
  const base = new Date(startIso).getTime();
  return () => new Date(base + tick++ * 1000);
}
