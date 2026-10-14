/**
 * The pdf.js boundary.
 *
 * One of exactly two files permitted to touch `pdfjs-dist`; the other is
 * `render.ts`, which needs a page object. A structural test asserts nothing
 * else imports it, so the parser layer and the domain stay free of a library
 * whose API has moved twice in four months.
 *
 * **Untrusted input.** Every document reaching this module came from outside.
 * The order of defences is deliberate: byte count first (free), then structural
 * parse, then page count, then per-page work. Anything that would provoke
 * expensive work is refused before the work happens.
 *
 * **Nothing is written to disk and nothing is retained.** The loading task is
 * destroyed in a `finally` on every path, including failure, so pdf.js releases
 * its worker and buffers. Page text and rendered bytes are returned to the
 * caller and held nowhere else.
 *
 * **Nothing here logs.** pdf.js is put in `ERRORS` verbosity because its default
 * warnings quote document structure to stdout, which for a bank statement is a
 * disclosure. `no-console` forbids the rest.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { fail, failure, ok, type Failure, type Result } from "@/lib/domain/failures";

import type { DocumentKind, ExtractedDocument, PageText } from "../port";
import { DEFAULT_INPUT_LIMITS, type InputLimits } from "./limits";

// ---------------------------------------------------------------------------
// The dependency surface, stated explicitly
// ---------------------------------------------------------------------------

/**
 * Exactly what this project uses from pdf.js.
 *
 * Declared structurally rather than imported from the package's own types on
 * purpose: it is a written record of the surface a version bump can break, and
 * it keeps the runtime import dynamic so the library is loaded only when a PDF
 * is actually processed.
 */
interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

export interface PdfPageHandle {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: {
    canvasContext: unknown;
    viewport: PdfViewport;
    canvas: unknown;
  }): { promise: Promise<void> };
}

export interface PdfDocumentHandle {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageHandle>;
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocumentHandle>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(source: Record<string, unknown>): PdfLoadingTask;
  readonly VerbosityLevel: { readonly ERRORS: number };
}

let cachedModule: PdfjsModule | undefined;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (cachedModule) return cachedModule;
  // The `legacy` build is the one pdf.js ships for Node; the default build
  // assumes browser globals. Verified against 6.2.108 on Node 24.
  const mod = (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as unknown as PdfjsModule;
  cachedModule = mod;
  return mod;
}

/**
 * Location of the standard-font data pdf.js needs for non-embedded fonts.
 *
 * Must be a *URL* ending in a slash. A native path is rejected outright, and on
 * Windows `join(dir, "x/")` drops the trailing separator and yields backslashes
 * -- both were observed before this was written this way.
 */
function standardFontDataUrl(): string {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  return `${pathToFileURL(join(packageRoot, "standard_fonts")).href}/`;
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

/**
 * Maps a pdf.js throw onto the taxonomy.
 *
 * Discriminates on `error.name` rather than `instanceof`: the exception classes
 * are module-scoped, and an `instanceof` check silently stops matching if the
 * package is ever loaded through a second module instance.
 *
 * The original error is preserved as `cause` and never formatted into `detail`
 * -- pdf.js messages can quote document structure.
 */
function mapPdfError(error: unknown): Failure {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";

  if (name === "PasswordException") {
    return failure(
      "UNSUPPORTED_INPUT",
      "the PDF is password-protected and cannot be read",
      error,
    );
  }
  if (name === "InvalidPDFException") {
    return failure("CORRUPT_DOCUMENT", "the PDF structure is invalid", error);
  }
  return failure("CORRUPT_DOCUMENT", "the PDF could not be opened", error);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface PdfOptions {
  readonly limits?: InputLimits;
}

/**
 * Opens a document, runs `use`, and always destroys the loading task.
 *
 * The single owner of the pdf.js lifecycle. `render.ts` borrows it rather than
 * opening its own document so there is exactly one `finally` to get right.
 */
export async function withPdfDocument<T>(
  bytes: Uint8Array,
  limits: InputLimits,
  use: (document: PdfDocumentHandle) => Promise<Result<T>>,
): Promise<Result<T>> {
  if (bytes.byteLength === 0) {
    return fail("CORRUPT_DOCUMENT", "the file is empty");
  }
  // Cheapest defence first: refuse on size before pdf.js sees the bytes at all.
  if (bytes.byteLength > limits.maxBytes) {
    return fail(
      "UNSUPPORTED_INPUT",
      `file is ${bytes.byteLength} bytes, above the ${limits.maxBytes}-byte limit`,
    );
  }

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    // Untrusted input: never let the document's own content be evaluated, and
    // never let it reach out for anything.
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  try {
    const document = await task.promise;
    if (document.numPages > limits.maxPages) {
      // Checked after the structural parse but before any page is touched.
      return fail(
        "UNSUPPORTED_INPUT",
        `document has ${document.numPages} pages, above the ${limits.maxPages}-page limit`,
      );
    }
    return await use(document);
  } catch (error) {
    return { ok: false, failure: mapPdfError(error) };
  } finally {
    // Releases the worker and every buffer, on success and on failure alike.
    await task.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function textOf(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item === "object" && item !== null && "str" in item) {
      const str = (item as { str: unknown }).str;
      if (typeof str === "string") parts.push(str);
    }
  }
  return parts.join(" ");
}

/**
 * Reads the text layer, reporting honestly when there is not one.
 *
 * A document with no text objects at all is `image-only`. That is a routing
 * signal rather than an error: an extractor that returned empty strings for a
 * scan would look exactly like a statement with no transactions.
 *
 * The threshold is zero non-whitespace characters across every page. Whether a
 * *degenerate* text layer -- page numbers only, or a partial OCR layer someone
 * else applied -- should also route to the scanned path is a corpus question
 * for M2b, not something to guess at with a percentage now.
 */
export async function extractPdfText(
  documentId: string,
  bytes: Uint8Array,
  options: PdfOptions = {},
): Promise<Result<ExtractedDocument>> {
  const limits = options.limits ?? DEFAULT_INPUT_LIMITS;

  return withPdfDocument(bytes, limits, async (document) => {
    const pages: PageText[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({
        page: pageNumber,
        text: textOf(content.items),
        itemCount: content.items.length,
      });
    }

    const hasText = pages.some((p) => p.text.trim().length > 0);
    const kind: DocumentKind = hasText ? "text-layer" : "image-only";

    return ok<ExtractedDocument>({
      documentId,
      pageCount: document.numPages,
      kind,
      // An image-only document carries no page text. Returning empty strings
      // would let a caller treat "not extracted" as "nothing on the page".
      pages: hasText ? pages : [],
    });
  });
}

/**
 * The gate for callers that need text.
 *
 * Separate from `extractPdfText` for the same reason `requireReconciled` is
 * separate from `reconcile`: reporting and deciding are different jobs, and a
 * router needs the report.
 */
export function requireTextLayer(
  document: ExtractedDocument,
): Result<ExtractedDocument> {
  if (document.kind === "image-only") {
    return fail(
      "MISSING_TEXT_LAYER",
      `document has no text layer across ${document.pageCount} page(s); the scanned path applies`,
    );
  }
  return ok(document);
}
