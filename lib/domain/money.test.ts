import { describe, expect, it } from "vitest";

import {
  ZERO,
  absSen,
  addSen,
  compareSen,
  formatSen,
  isNegative,
  isZero,
  negateSen,
  parseAmount,
  parseMagnitude,
  sen,
  subSen,
  sumSen,
} from "./money";

/** Unwraps a parse that must have succeeded, with a useful message if not. */
function amount(raw: string): bigint {
  const r = parseAmount(raw);
  if (!r.ok) throw new Error(`expected "${raw}" to parse: ${r.failure.detail}`);
  return r.value;
}

function rejection(raw: string) {
  const r = parseAmount(raw);
  if (r.ok) throw new Error(`expected "${raw}" to be rejected, got ${r.value}`);
  return r.failure;
}

describe("parseAmount — accepted forms", () => {
  it.each([
    ["0", 0n],
    ["0.00", 0n],
    ["1", 100n],
    ["0.05", 5n],
    ["0.5", 50n],
    ["1234.56", 123456n],
    ["1,234.56", 123456n],
    ["1,234,567.89", 123456789n],
    ["12,345", 1234500n],
    ["999999999", 99999999900n],
  ])("reads %s as %s sen", (raw, expected) => {
    expect(amount(raw)).toBe(expected);
  });

  it.each([
    ["-1,234.56", -123456n],
    ["(1,234.56)", -123456n],
    ["1,234.56 DR", -123456n],
    ["1,234.56DR", -123456n],
    ["1,234.56 dr", -123456n],
    ["−1,234.56", -123456n], // U+2212, routinely produced by PDF text extraction
  ])("treats %s as money out", (raw, expected) => {
    expect(amount(raw)).toBe(expected);
  });

  it.each([
    ["1,234.56 CR", 123456n],
    ["1,234.56cr", 123456n],
    ["+1,234.56", 123456n],
  ])("treats %s as money in", (raw, expected) => {
    expect(amount(raw)).toBe(expected);
  });

  it.each([
    ["RM1,234.56", 123456n],
    ["RM 1,234.56", 123456n],
    ["MYR 1,234.56", 123456n],
    ["  1,234.56  ", 123456n],
  ])("tolerates currency prefix and surrounding space in %s", (raw, expected) => {
    expect(amount(raw)).toBe(expected);
  });
});

describe("parseAmount — rejections", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "not a decimal"],
    ["1,23.45", "grouping"],
    ["1.234,56", "grouping"],
    ["1,2345.00", "grouping"],
    [".56", "not a decimal"],
    ["1,234.567", "two decimal places"],
    ["--5.00", "not a decimal"],
    ["(1,234.56", "unbalanced"],
    ["1,234.56)", "unbalanced"],
    ["(1,234.56) DR", "more than one negation"],
    ["-1,234.56 DR", "more than one negation"],
    ["-1,234.56 CR", "CR combined"],
    ["(1,234.56) CR", "CR combined"],
  ])("rejects %s", (raw, fragment) => {
    const f = rejection(raw);
    expect(f.kind).toBe("INVALID_MONETARY_VALUE");
    expect(f.detail.toLowerCase()).toContain(fragment.toLowerCase());
  });

  it("rejects a third decimal place rather than rounding to sen", () => {
    // CLAUDE.md non-negotiable 3: nothing silently absorbs a difference.
    expect(rejection("10.005").detail).toContain("rounding");
  });
});

describe("parseAmount — failures never echo the value", () => {
  // An amount is financial content; a malformed amount is still financial
  // content. lib/domain/failures.ts documents this rule and this is its proof.
  it.each(["9876543.21999", "1,2345.67", "(4242.42) DR", "-8888.88 CR"])(
    "does not quote %s back",
    (raw) => {
      const detail = rejection(raw).detail;
      const digitRuns = raw.match(/\d{3,}/g) ?? [];
      expect(digitRuns.length).toBeGreaterThan(0);
      for (const run of digitRuns) {
        expect(detail).not.toContain(run);
      }
    },
  );
});

describe("parseMagnitude", () => {
  it("accepts an unsigned column amount", () => {
    const r = parseMagnitude("1,234.56");
    expect(r.ok && r.value).toBe(123456n);
  });

  it.each(["-1,234.56", "(1,234.56)", "1,234.56 DR"])(
    "rejects %s because a column carries direction positionally",
    (raw) => {
      const r = parseMagnitude(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.detail).toContain("positional");
    },
  );
});

describe("arithmetic is exact", () => {
  it("shows the hazard the sen representation avoids", () => {
    // The control. This is what happens with floats, and why balances are not
    // JS numbers in this codebase.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("adds the same values exactly in sen", () => {
    expect(addSen(sen(10n), sen(20n))).toBe(30n);
  });

  it("accumulates ten thousand single sen without drift", () => {
    const ones = Array.from({ length: 10_000 }, () => sen(1n));
    expect(sumSen(ones)).toBe(10_000n);
  });

  it("survives values far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = sen(9_007_199_254_740_993n); // MAX_SAFE_INTEGER + 2
    expect(addSen(huge, sen(1n))).toBe(9_007_199_254_740_994n);
  });

  it("subtracts, negates and takes magnitude", () => {
    expect(subSen(sen(100n), sen(250n))).toBe(-150n);
    expect(negateSen(sen(-150n))).toBe(150n);
    expect(absSen(sen(-150n))).toBe(150n);
    expect(absSen(sen(150n))).toBe(150n);
  });

  it("sums an empty list to zero", () => {
    expect(sumSen([])).toBe(ZERO);
  });

  it("compares exactly, with no epsilon", () => {
    expect(compareSen(sen(1n), sen(2n))).toBe(-1);
    expect(compareSen(sen(2n), sen(2n))).toBe(0);
    expect(compareSen(sen(3n), sen(2n))).toBe(1);
  });

  it("classifies zero and sign", () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(sen(1n))).toBe(false);
    expect(isNegative(sen(-1n))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
  });
});

describe("formatSen", () => {
  it.each([
    [0n, "0.00"],
    [5n, "0.05"],
    [50n, "0.50"],
    [100n, "1.00"],
    [123456n, "1,234.56"],
    [123456789n, "1,234,567.89"],
    [-123456n, "-1,234.56"],
    [99999999900n, "999,999,999.00"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatSen(sen(value))).toBe(expected);
  });

  it("round-trips through parseAmount", () => {
    for (const raw of ["0.00", "1,234.56", "-1,234.56", "999,999,999.00"]) {
      expect(formatSen(sen(amount(raw)))).toBe(raw);
    }
  });

  it("is locale-independent", () => {
    // No Intl, no toLocaleString: the output must not depend on the host.
    expect(formatSen(sen(123456n))).toBe("1,234.56");
    expect(formatSen(sen(123456n))).not.toContain(" ");
  });
});
