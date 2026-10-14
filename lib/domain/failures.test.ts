import { describe, expect, it } from "vitest";

import {
  MAX_DETAIL_LENGTH,
  allOk,
  err,
  fail,
  failure,
  isRetryable,
  ok,
  publicFailure,
  type FailureKind,
} from "./failures";

/** Every kind, listed so a new one fails this file until it is classified. */
const ALL_KINDS: readonly FailureKind[] = [
  "UNSUPPORTED_INPUT",
  "CORRUPT_DOCUMENT",
  "MISSING_TEXT_LAYER",
  "RENDERING_FAILED",
  "AMBIGUOUS_DATE",
  "INVALID_MONETARY_VALUE",
  "EXTRACTION_VALIDATION_FAILED",
  "RECONCILIATION_FAILED",
  "COST_CEILING_EXCEEDED",
  "PROVIDER_FAILED",
  "PROCESSING_FAILED_RETRYABLE",
  "PROCESSING_FAILED_PERMANENT",
];

describe("retryability", () => {
  it.each(["PROVIDER_FAILED", "PROCESSING_FAILED_RETRYABLE"] as const)(
    "treats %s as worth another attempt",
    (kind) => {
      expect(isRetryable(failure(kind, "x"))).toBe(true);
    },
  );

  it("never retries a cost-ceiling breach", () => {
    // Retrying a call refused for budget reasons spends the budget it was
    // refused to protect. The ceiling has to move first, and that is a person's
    // decision (CLAUDE.md non-negotiable 5).
    expect(isRetryable(failure("COST_CEILING_EXCEEDED", "over"))).toBe(false);
  });

  it("never retries a failed reconciliation", () => {
    // The same bytes reconcile the same way. It is an exception awaiting a
    // human, not a transient error (non-negotiable 3).
    expect(isRetryable(failure("RECONCILIATION_FAILED", "off by 1"))).toBe(
      false,
    );
  });

  it("classifies every kind explicitly", () => {
    // A kind added without a decision about retryability would otherwise
    // default to "permanent" silently.
    for (const kind of ALL_KINDS) {
      expect(typeof isRetryable(failure(kind, "x"))).toBe("boolean");
    }
    expect(ALL_KINDS.filter((k) => isRetryable(failure(k, "x")))).toEqual([
      "PROVIDER_FAILED",
      "PROCESSING_FAILED_RETRYABLE",
    ]);
  });
});

describe("cause never crosses a trust boundary", () => {
  it("keeps the cause on the failure for operators", () => {
    const cause = new Error("connection reset");
    expect(failure("PROVIDER_FAILED", "provider unreachable", cause).cause).toBe(
      cause,
    );
  });

  it("drops the cause from the public shape", () => {
    const cause = { secret: "sk-live-not-a-real-key", page: "…statement text…" };
    const pub = publicFailure(failure("PROVIDER_FAILED", "provider failed", cause));

    expect(pub).toEqual({ kind: "PROVIDER_FAILED", detail: "provider failed" });
    expect("cause" in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("sk-live");
    expect(JSON.stringify(pub)).not.toContain("statement text");
  });

  it("omits the key entirely when there is no cause", () => {
    expect("cause" in failure("UNSUPPORTED_INPUT", "nope")).toBe(false);
  });
});

describe("detail is bounded", () => {
  it("truncates an over-long detail", () => {
    // Not the security control -- the no-content rule is -- but it stops an
    // accidental page of extracted text reaching a log through a failure.
    const f = failure("CORRUPT_DOCUMENT", "x".repeat(5_000));
    expect(f.detail.length).toBe(MAX_DETAIL_LENGTH);
    expect(f.detail.endsWith("…")).toBe(true);
  });

  it("leaves a short detail untouched", () => {
    expect(failure("CORRUPT_DOCUMENT", "short").detail).toBe("short");
  });
});

describe("Result", () => {
  it("carries a value on success", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("carries a failure on error", () => {
    const r = err<number>(failure("UNSUPPORTED_INPUT", "no"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("UNSUPPORTED_INPUT");
  });

  it("builds a failed result inline", () => {
    const r = fail<number>("CORRUPT_DOCUMENT", "broken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toBe("broken");
  });
});

describe("allOk", () => {
  it("collects every value when all succeed", () => {
    const r = allOk([ok(1), ok(2), ok(3)]);
    expect(r.ok && r.value).toEqual([1, 2, 3]);
  });

  it("returns the first failure and stops", () => {
    // Fail-fast on purpose. A statement with one unreadable amount is not
    // partially usable, and "here are the lines that worked" is exactly how a
    // wrong total reaches an accountant.
    const r = allOk([
      ok(1),
      fail<number>("INVALID_MONETARY_VALUE", "first"),
      fail<number>("INVALID_MONETARY_VALUE", "second"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toBe("first");
  });

  it("returns an empty list for no inputs", () => {
    const r = allOk<number>([]);
    expect(r.ok && r.value).toEqual([]);
  });
});
