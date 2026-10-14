import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  parseMaxUploadBytes,
  validateUpload,
} from "./validation";

/** A well-formed PDF header, so the signature check is never what rejects. */
function pdfOfSize(bytes: number): Uint8Array {
  const b = new Uint8Array(bytes);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // "%PDF-"
  return b;
}

describe("the configured upload cap is parsed, not coerced", () => {
  it("uses the default when the variable is absent", () => {
    expect(parseMaxUploadBytes(undefined)).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
  });

  it("accepts a plain positive integer, which is the documented form", () => {
    // The value shipped in .env.example. If this ever fails, the example file
    // is telling operators to configure something the code rejects.
    expect(parseMaxUploadBytes("15728640")).toBe(15728640);
    expect(parseMaxUploadBytes("1")).toBe(1);
  });

  it.each([
    ["15MB", "a unit suffix — the observed real-world typo"],
    ["fifteen", "a word"],
    ["15 728 640", "digit grouping with spaces"],
    ["", "an empty assignment, MAX_UPLOAD_BYTES= in an env file"],
    ["   ", "whitespace only"],
    ["0", "zero, which would reject every non-empty upload"],
    ["-1", "negative, which would reject every upload"],
    ["1.5", "fractional, which is not a whole number of bytes"],
    ["Infinity", "no cap at all, spelled obscurely"],
    ["-Infinity", "non-finite and negative"],
    ["NaN", "the failure mode named literally"],
  ])("refuses %j — %s", (raw) => {
    expect(() => parseMaxUploadBytes(raw)).toThrow(/MAX_UPLOAD_BYTES/);
  });

  it("names the offending value so the operator can fix it", () => {
    // Not a secret: docs/SETUP.md §2 classifies MAX_UPLOAD_BYTES as
    // non-secret, which is why echoing it here is allowed and useful.
    expect(() => parseMaxUploadBytes("15MB")).toThrow(/"15MB"/);
  });

  it("never returns a value that cannot function as a cap", () => {
    // The property, rather than a list of cases: whatever comes back is a
    // positive integer, so `length > limit` can never be vacuously false.
    for (const raw of [undefined, "1", "15728640", "1e6", "0x10"]) {
      const limit = parseMaxUploadBytes(raw);
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });

  it("is a usable cap as actually wired into the module", () => {
    expect(Number.isInteger(MAX_UPLOAD_BYTES)).toBe(true);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
  });
});

describe("the negative control: the fail-open this fix closes", () => {
  it("confirms the old coercion really did remove the cap", () => {
    // Guards against a vacuous suite. If `Number` ever stopped yielding NaN
    // here, these tests would still pass while protecting against nothing --
    // so the defect mechanism itself is asserted, not assumed.
    const oldLimit = Number("15MB");
    expect(Number.isNaN(oldLimit)).toBe(true);
    expect(20 * 1024 * 1024 > oldLimit).toBe(false); // the silent acceptance
  });

  it("turns that silent acceptance into a loud refusal", () => {
    expect(() => parseMaxUploadBytes("15MB")).toThrow();
  });
});

describe("validateUpload still enforces the cap it is given", () => {
  it("rejects a file over the limit", () => {
    const r = validateUpload({
      bytes: pdfOfSize(MAX_UPLOAD_BYTES + 1),
      declaredType: "application/pdf",
      filename: "big.pdf",
    });
    expect(r).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("accepts a file at exactly the limit — the boundary is inclusive", () => {
    const r = validateUpload({
      bytes: pdfOfSize(MAX_UPLOAD_BYTES),
      declaredType: "application/pdf",
      filename: "exact.pdf",
    });
    expect(r).toMatchObject({ ok: true, contentType: "application/pdf" });
  });
});
