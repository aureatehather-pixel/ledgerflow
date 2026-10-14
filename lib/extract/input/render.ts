/**
 * Page rasterisation.
 *
 * The only file permitted to touch `@napi-rs/canvas`, and one of two permitted
 * to touch `pdfjs-dist`. A structural test enforces both.
 *
 * **No OCR.** This produces pixels; it does not attempt to read them. A scanned
 * statement reaches a vision model through `lib/extract/model`, and nothing in
 * this repository converts an image back into text locally. Anything claiming
 * otherwise would be claiming an accuracy nobody has measured.
 *
 * **Nothing touches disk.** Rendered bytes are returned to the caller and held
 * nowhere else; the canvas and the pdf.js document are released before this
 * returns. There is no temporary file to clean up because none is created.
 */

import { fail, failure, ok, type Result } from "@/lib/domain/failures";

import type { RenderedPage } from "../port";
import {
  DEFAULT_INPUT_LIMITS,
  scaleWithinPixelBudget,
  type InputLimits,
} from "./limits";
import { withPdfDocument, type PdfPageHandle } from "./pdf";

/** Exactly what this project uses from the canvas binding. */
interface CanvasHandle {
  readonly width: number;
  readonly height: number;
  getContext(kind: "2d"): unknown;
  toBuffer(mime: "image/png"): Buffer;
}

interface CanvasModule {
  createCanvas(width: number, height: number): CanvasHandle;
}

let cachedModule: CanvasModule | undefined;

async function loadCanvas(): Promise<CanvasModule> {
  if (cachedModule) return cachedModule;
  // Prebuilt per-platform binaries; no compiler is required at install time.
  // Portability is the standing risk -- see docs/decisions/0003.
  const mod = (await import("@napi-rs/canvas")) as unknown as CanvasModule;
  cachedModule = mod;
  return mod;
}

async function rasterise(
  page: PdfPageHandle,
  pageNumber: number,
  limits: InputLimits,
): Promise<Result<RenderedPage>> {
  const base = page.getViewport({ scale: 1 });
  const scale = scaleWithinPixelBudget(base.width, base.height, limits);
  if (scale === null) {
    // Refused rather than shrunk. A page silently rendered at a fraction of the
    // requested scale would be unreadable and would look like a success.
    return fail(
      "RENDERING_FAILED",
      `page ${pageNumber} is ${Math.round(base.width)}x${Math.round(base.height)} units, beyond the ${limits.maxRenderPixels}-pixel budget`,
    );
  }

  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width <= 0 || height <= 0) {
    return fail("RENDERING_FAILED", `page ${pageNumber} has no printable area`);
  }

  try {
    const { createCanvas } = await loadCanvas();
    const canvas = createCanvas(width, height);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      canvas,
    }).promise;

    return ok<RenderedPage>({
      page: pageNumber,
      width: canvas.width,
      height: canvas.height,
      mediaType: "image/png",
      bytes: new Uint8Array(canvas.toBuffer("image/png")),
    });
  } catch (error) {
    // The cause is retained for operators; the detail names the page only.
    return {
      ok: false,
      failure: failure(
        "RENDERING_FAILED",
        `page ${pageNumber} could not be rasterised`,
        error,
      ),
    };
  }
}

export interface RenderOptions {
  readonly limits?: InputLimits;
  /** 1-indexed pages to render. Omitted means every page. */
  readonly pages?: readonly number[];
}

/**
 * Rasterises selected pages to PNG.
 *
 * Fails on the first page that cannot be rendered rather than returning a
 * partial set: a caller handed nine of ten pages has no way to know the tenth
 * was the one with the closing balance.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  options: RenderOptions = {},
): Promise<Result<RenderedPage[]>> {
  const limits = options.limits ?? DEFAULT_INPUT_LIMITS;

  return withPdfDocument(bytes, limits, async (document) => {
    const requested =
      options.pages ??
      Array.from({ length: document.numPages }, (_, i) => i + 1);

    for (const pageNumber of requested) {
      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > document.numPages
      ) {
        return fail<RenderedPage[]>(
          "RENDERING_FAILED",
          `page ${pageNumber} is outside a ${document.numPages}-page document`,
        );
      }
    }

    const rendered: RenderedPage[] = [];
    for (const pageNumber of requested) {
      const page = await document.getPage(pageNumber);
      const result = await rasterise(page, pageNumber, limits);
      if (!result.ok) return { ok: false, failure: result.failure };
      rendered.push(result.value);
    }
    return ok(rendered);
  });
}
