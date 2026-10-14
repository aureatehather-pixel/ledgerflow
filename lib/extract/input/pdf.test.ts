import { describe, expect, it } from "vitest";

import {
  SYNTHETIC_MARKER,
  bornDigitalPdf,
  emptyPdf,
  encryptedPdf,
  imageOnlyPdf,
  malformedPdf,
  manyPagePdf,
  syntheticStatementPdf,
} from "../testing";
import { DEFAULT_INPUT_LIMITS } from "./limits";
import { extractPdfText, requireTextLayer } from "./pdf";

const DOC = "00000000-0000-7000-8000-0000000000aa";

async function extracted(bytes: Uint8Array, limits = DEFAULT_INPUT_LIMITS) {
  const r = await extractPdfText(DOC, bytes, { limits });
  if (!r.ok) throw new Error(`expected extraction to succeed: ${r.failure.detail}`);
  return r.value;
}

async function rejected(bytes: Uint8Array, limits = DEFAULT_INPUT_LIMITS) {
  const r = await extractPdfText(DOC, bytes, { limits });
  if (r.ok) throw new Error("expected extraction to fail");
  return r.failure;
}

describe("born-digital PDFs", () => {
  it("extracts the text layer", async () => {
    const doc = await extracted(
      bornDigitalPdf([["HELLO STATEMENT", "OPENING BALANCE 1,000.00"]]),
    );
    expect(doc.kind).toBe("text-layer");
    expect(doc.pageCount).toBe(1);
    expect(doc.pages[0]?.text).toContain("HELLO STATEMENT");
    expect(doc.pages[0]?.text).toContain("OPENING BALANCE 1,000.00");
  });

  it("preserves page numbers and keeps page text separate", async () => {
    const doc = await extracted(
      bornDigitalPdf([["PAGE ONE ALPHA"], ["PAGE TWO BETA"], ["PAGE THREE GAMMA"]]),
    );

    expect(doc.pageCount).toBe(3);
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(doc.pages[0]?.text).toContain("ALPHA");
    expect(doc.pages[0]?.text).not.toContain("BETA");
    expect(doc.pages[1]?.text).toContain("BETA");
    expect(doc.pages[2]?.text).toContain("GAMMA");
  });

  it("carries the document id through unchanged", async () => {
    const doc = await extracted(syntheticStatementPdf());
    expect(doc.documentId).toBe(DOC);
    expect(doc.pages[0]?.text).toContain(SYNTHETIC_MARKER);
  });

  it("reports a text-item count per page", async () => {
    const doc = await extracted(bornDigitalPdf([["A", "B", "C"]]));
    expect(doc.pages[0]?.itemCount).toBeGreaterThan(0);
  });

  it("passes the text-layer gate", async () => {
    const doc = await extracted(bornDigitalPdf([["SOMETHING"]]));
    expect(requireTextLayer(doc).ok).toBe(true);
  });
});

describe("image-only PDFs", () => {
  it("is reported as image-only rather than as an empty statement", async () => {
    // The honest-reporting requirement: an extractor that returned empty
    // strings here would look exactly like a statement with no transactions.
    const doc = await extracted(imageOnlyPdf());
    expect(doc.kind).toBe("image-only");
    expect(doc.pageCount).toBe(1);
  });

  it("returns no page text at all, rather than empty strings", async () => {
    const doc = await extracted(imageOnlyPdf());
    expect(doc.pages).toEqual([]);
  });

  it("fails the text-layer gate with a typed, routing-shaped failure", async () => {
    const doc = await extracted(imageOnlyPdf());
    const gate = requireTextLayer(doc);

    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.failure.kind).toBe("MISSING_TEXT_LAYER");
      expect(gate.failure.detail).toContain("scanned path");
    }
  });

  it("does not attempt OCR", async () => {
    // Nothing in M2a converts pixels back into text. If OCR were silently
    // running, this document would come back with characters in it.
    const doc = await extracted(imageOnlyPdf());
    expect(doc.pages.flatMap((p) => p.text)).toEqual([]);
  });
});

describe("hostile and broken input", () => {
  it("rejects a malformed PDF with a bounded, typed failure", async () => {
    const f = await rejected(malformedPdf());
    expect(f.kind).toBe("CORRUPT_DOCUMENT");
    expect(f.detail).toBe("the PDF structure is invalid");
    expect(f.detail.length).toBeLessThan(200);
  });

  it("rejects an empty file", async () => {
    const f = await rejected(emptyPdf());
    expect(f.kind).toBe("CORRUPT_DOCUMENT");
    expect(f.detail).toContain("empty");
  });

  it("rejects an encrypted PDF instead of returning nothing", async () => {
    const f = await rejected(encryptedPdf());
    expect(f.kind).toBe("UNSUPPORTED_INPUT");
    expect(f.detail).toContain("password-protected");
  });

  it("retains the provider error as a cause without leaking it into detail", async () => {
    const f = await rejected(malformedPdf());
    expect(f.cause).toBeDefined();
    // pdf.js messages can quote document structure; the detail is ours.
    expect(f.detail).not.toContain("Invalid PDF structure");
  });
});

describe("limits are enforced before the work they bound", () => {
  it("refuses an oversized file without opening it", async () => {
    const bytes = bornDigitalPdf([["SOMETHING"]]);
    const f = await rejected(bytes, { ...DEFAULT_INPUT_LIMITS, maxBytes: 10 });

    expect(f.kind).toBe("UNSUPPORTED_INPUT");
    expect(f.detail).toContain("above the 10-byte limit");
    // No cause: pdf.js was never handed the bytes.
    expect(f.cause).toBeUndefined();
  });

  it("refuses a document above the page limit", async () => {
    const f = await rejected(manyPagePdf(5), {
      ...DEFAULT_INPUT_LIMITS,
      maxPages: 3,
    });
    expect(f.kind).toBe("UNSUPPORTED_INPUT");
    expect(f.detail).toContain("5 pages");
    expect(f.detail).toContain("3-page limit");
  });

  it("accepts a document exactly at the page limit", async () => {
    const doc = await extracted(manyPagePdf(3), {
      ...DEFAULT_INPUT_LIMITS,
      maxPages: 3,
    });
    expect(doc.pageCount).toBe(3);
  });
});

describe("failure details name shape, never content", () => {
  it("does not quote extracted text in any failure", async () => {
    const secret = "ACCOUNT 8888888888 BALANCE 999,999.99";
    const f = await rejected(bornDigitalPdf([[secret]]), {
      ...DEFAULT_INPUT_LIMITS,
      maxPages: 0,
    });
    expect(f.detail).not.toContain("8888888888");
    expect(f.detail).not.toContain("999,999.99");
  });
});
