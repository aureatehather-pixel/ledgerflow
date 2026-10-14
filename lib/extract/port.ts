/**
 * The extraction boundary.
 *
 * Everything in this file is provider-neutral by construction: no pdfjs type,
 * no canvas type, no PDF concept beyond "pages". `lib/extract/input/` owns those
 * libraries and converts their output into the shapes below, so a parser -- and
 * therefore every bank layout M2b eventually adds -- is written against this
 * file and cannot become coupled to a PDF library's API.
 *
 * That matters more than it looks. `pdfjs-dist` shipped 5.6 through 6.2 in four
 * months and moved `destroy()` off the document object between majors; a parser
 * that had reached into those types would have to be revisited on every bump.
 *
 * Parsers emit a `StatementDraft` -- a *candidate*. They cannot produce a
 * validated `Statement`, because `validateStatement` is the only source of one
 * and lives in the domain. A parser therefore cannot assert that what it read is
 * well-formed; it can only propose it.
 */

import type { Result } from "@/lib/domain/failures";
import type { StatementDraft } from "@/lib/domain/statement";

/** Text recovered from one page. `page` is 1-indexed, as a human counts. */
export interface PageText {
  readonly page: number;
  readonly text: string;
  /** Number of distinct text runs pdf.js reported. Zero means the page carried
   *  no text objects at all, which is how a scan is recognised. */
  readonly itemCount: number;
}

/**
 * Whether the document carries text that can be read without rasterising it.
 *
 * `image-only` is a routing signal, not a defect: it means the scanned path
 * applies. Reporting it honestly is the whole point -- an extractor that
 * returned empty strings for a scan would look like a document with no
 * transactions.
 */
export type DocumentKind = "text-layer" | "image-only";

/** What a parser sees. Provider-neutral. */
export interface ExtractedDocument {
  readonly documentId: string;
  readonly pageCount: number;
  readonly kind: DocumentKind;
  /** Per-page text, in page order. Empty when `kind` is `image-only`. */
  readonly pages: readonly PageText[];
}

/** A rasterised page, for the vision path. Bytes are in memory only. */
export interface RenderedPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly bytes: Uint8Array;
}

export interface ParseContext {
  readonly documentId: string;
}

/**
 * A parser for one document layout.
 *
 * No layout parser exists yet and none may be invented: `CLAUDE.md`
 * non-negotiable 8 says a parser validated only against documents I generated
 * has been validated against my own assumptions. This interface is the shape
 * M2b fills once a real corpus exists.
 */
export interface StatementParser {
  /** Stable, unique. Recorded on the extraction run so a result can be traced
   *  back to the code that produced it. */
  readonly id: string;
  readonly description: string;
  /**
   * Whether this parser claims the document. Must be deterministic and cheap:
   * the registry calls it on every candidate, in order, for every document.
   */
  supports(document: ExtractedDocument): boolean;
  parse(
    document: ExtractedDocument,
    context: ParseContext,
  ): Promise<Result<StatementDraft>>;
}
