import { describe, expect, it } from "vitest";

import {
  bornDigitalPdf,
  encryptedPdf,
  hugePagePdf,
  imageOnlyPdf,
  malformedPdf,
} from "../testing";
import {
  DEFAULT_INPUT_LIMITS,
  scaleWithinPixelBudget,
  type InputLimits,
} from "./limits";
import { renderPdfPages } from "./render";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

async function rendered(bytes: Uint8Array, options = {}) {
  const r = await renderPdfPages(bytes, options);
  if (!r.ok) throw new Error(`expected rendering to succeed: ${r.failure.detail}`);
  return r.value;
}

async function rejected(bytes: Uint8Array, options = {}) {
  const r = await renderPdfPages(bytes, options);
  if (r.ok) throw new Error("expected rendering to fail");
  return r.failure;
}

describe("rasterising pages", () => {
  it("renders a born-digital page to a real PNG", async () => {
    const pages = await rendered(bornDigitalPdf([["HELLO STATEMENT"]]));

    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.page).toBe(1);
    expect(page?.mediaType).toBe("image/png");
    expect(page?.width).toBeGreaterThan(0);
    expect(page?.height).toBeGreaterThan(0);
    expect([...(page?.bytes.slice(0, 4) ?? [])]).toEqual(PNG_MAGIC);
  });

  it("renders an image-only page, which is the whole point of this path", async () => {
    // A scan has no text layer; pixels are the only way to reach its contents.
    const pages = await rendered(imageOnlyPdf());
    expect(pages).toHaveLength(1);
    expect([...(pages[0]?.bytes.slice(0, 4) ?? [])]).toEqual(PNG_MAGIC);
  });

  it("renders every page by default, in order", async () => {
    const pages = await rendered(
      bornDigitalPdf([["ONE"], ["TWO"], ["THREE"]]),
    );
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("renders only the pages asked for", async () => {
    const pages = await rendered(bornDigitalPdf([["ONE"], ["TWO"], ["THREE"]]), {
      pages: [3, 1],
    });
    expect(pages.map((p) => p.page)).toEqual([3, 1]);
  });

  it("scales up from the 72-unit PDF page, so output is not letter-sized", async () => {
    const pages = await rendered(bornDigitalPdf([["X"]]));
    // 612x792 user units at the default scale of 2.
    expect(pages[0]?.width).toBe(1224);
    expect(pages[0]?.height).toBe(1584);
  });
});

describe("rendering refuses rather than degrading", () => {
  it("rejects a page beyond the pixel budget instead of shrinking it", async () => {
    // A PDF may declare any MediaBox, so one page can demand billions of
    // pixels. Rendering it tiny would look like a success and be unreadable.
    const f = await rejected(hugePagePdf());
    expect(f.kind).toBe("RENDERING_FAILED");
    expect(f.detail).toContain("pixel budget");
  });

  it("rejects a page outside the document", async () => {
    const f = await rejected(bornDigitalPdf([["ONE"]]), { pages: [2] });
    expect(f.kind).toBe("RENDERING_FAILED");
    expect(f.detail).toContain("outside a 1-page document");
  });

  it.each([0, -1, 1.5])("rejects page index %s", async (page) => {
    const f = await rejected(bornDigitalPdf([["ONE"]]), { pages: [page] });
    expect(f.kind).toBe("RENDERING_FAILED");
  });

  it("fails the whole request rather than returning a partial set", async () => {
    // A caller handed nine of ten pages cannot know the tenth held the closing
    // balance.
    const r = await renderPdfPages(bornDigitalPdf([["ONE"], ["TWO"]]), {
      pages: [1, 99],
    });
    expect(r.ok).toBe(false);
  });

  it("propagates input failures from the shared lifecycle", async () => {
    expect((await rejected(malformedPdf())).kind).toBe("CORRUPT_DOCUMENT");
    expect((await rejected(encryptedPdf())).kind).toBe("UNSUPPORTED_INPUT");
  });

  it("enforces the byte limit before rendering", async () => {
    const f = await rejected(bornDigitalPdf([["ONE"]]), {
      limits: { ...DEFAULT_INPUT_LIMITS, maxBytes: 10 },
    });
    expect(f.detail).toContain("above the 10-byte limit");
  });
});

describe("scaleWithinPixelBudget", () => {
  const limits: InputLimits = {
    ...DEFAULT_INPUT_LIMITS,
    maxRenderPixels: 1_000_000,
    renderScale: 2,
  };

  it("uses the preferred scale when it fits", () => {
    // 100x100 at scale 2 is 40,000 pixels, far inside the budget.
    expect(scaleWithinPixelBudget(100, 100, limits)).toBe(2);
  });

  it("reduces the scale rather than exceeding the budget", () => {
    // 1000x1000 at scale 2 would be 4,000,000; the budget allows scale 1.
    expect(scaleWithinPixelBudget(1000, 1000, limits)).toBe(1);
  });

  it("returns null when even scale 1 is too large", () => {
    expect(scaleWithinPixelBudget(2000, 2000, limits)).toBeNull();
  });

  it("returns null for a degenerate page", () => {
    expect(scaleWithinPixelBudget(0, 100, limits)).toBeNull();
    expect(scaleWithinPixelBudget(-1, 100, limits)).toBeNull();
  });
});
