/**
 * Generated PDF fixtures and a wiring-only parser.
 *
 * Every fixture is assembled byte by byte at test time. Nothing is committed as
 * a binary (`CLAUDE.md` non-negotiable 1) and nothing here resembles a real bank
 * statement -- these exercise the input paths and the registry, and **no layout
 * may be inferred from them** (non-negotiable 8).
 *
 * Deliberately built without `@napi-rs/canvas`, even for the image fixture: the
 * structural test that keeps canvas inside `input/render.ts` is worth more than
 * the convenience, and a raw RGB image XObject needs no encoder.
 */

import { ok, type Result } from "@/lib/domain/failures";
import { isoDate } from "@/lib/domain/dates";
import { sen } from "@/lib/domain/money";
import type { StatementDraft } from "@/lib/domain/statement";

import type { ExtractedDocument, ParseContext, StatementParser } from "./port";

// ---------------------------------------------------------------------------
// PDF assembly
// ---------------------------------------------------------------------------

const latin1 = (s: string): Buffer => Buffer.from(s, "latin1");

/** Writes objects, the cross-reference table and the trailer. */
function assemble(
  objects: readonly (string | Buffer)[],
  extraTrailer = "",
): Uint8Array {
  const parts: Buffer[] = [latin1("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;

  objects.forEach((object, index) => {
    offsets.push(length);
    const body = typeof object === "string" ? latin1(object) : object;
    const chunk = Buffer.concat([
      latin1(`${index + 1} 0 obj\n`),
      body,
      latin1("\nendobj\n"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });

  const xref = length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  tail += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R${extraTrailer}>>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(latin1(tail));

  return new Uint8Array(Buffer.concat(parts));
}

function stream(dictionary: string, body: Buffer): Buffer {
  return Buffer.concat([
    latin1(`<<${dictionary}/Length ${body.length}>>\nstream\n`),
    body,
    latin1("\nendstream"),
  ]);
}

/** Marker the wiring-only parser below looks for. Not a bank format. */
export const SYNTHETIC_MARKER = "SYNTHETIC-STATEMENT-V1";

/**
 * A born-digital PDF with a real, extractable text layer.
 *
 * `pages` is one array of lines per page, so page provenance can be asserted
 * rather than assumed.
 */
export function bornDigitalPdf(pages: readonly (readonly string[])[]): Uint8Array {
  const pageCount = Math.max(1, pages.length);
  const pageObjectNumbers: number[] = [];
  const objects: (string | Buffer)[] = [
    "", // 1: catalog, filled below
    "", // 2: page tree, filled below
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", // 3
  ];

  for (let i = 0; i < pageCount; i += 1) {
    const lines = pages[i] ?? [];
    const escaped = lines.map((l) => l.replace(/([\\()])/g, "\\$1"));
    const text = escaped
      .map((l, n) => `${n === 0 ? "" : "0 -16 Td "}(${l}) Tj`)
      .join(" ");
    const content = `BT /F1 12 Tf 72 720 Td ${text} ET`;

    const contentNumber = objects.length + 2;
    const pageNumber = objects.length + 1;
    pageObjectNumbers.push(pageNumber);
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentNumber} 0 R>>`,
    );
    objects.push(stream("", latin1(content)));
  }

  objects[0] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[1] = `<</Type/Pages/Kids[${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}]/Count ${pageCount}>>`;
  return assemble(objects);
}

/** A born-digital PDF the wiring-only parser claims. */
export function syntheticStatementPdf(): Uint8Array {
  return bornDigitalPdf([
    [SYNTHETIC_MARKER, "OPENING 1,000.00", "CLOSING 1,000.00"],
    ["PAGE TWO CONTINUATION"],
  ]);
}

/**
 * A PDF whose only content is a raster image: no fonts, no text objects.
 *
 * This is the shape a scan takes. The image is an 8x8 raw RGB gradient with no
 * filter -- valid, tiny, and needing no encoder.
 */
export function imageOnlyPdf(): Uint8Array {
  const w = 8;
  const h = 8;
  const pixels = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i += 1) {
    pixels[i * 3] = (i * 3) % 256;
    pixels[i * 3 + 1] = (i * 5) % 256;
    pixels[i * 3 + 2] = (i * 7) % 256;
  }

  return assemble([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>",
    stream("", latin1("q 400 0 0 200 0 0 cm /Im0 Do Q")),
    stream(
      `/Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8`,
      pixels,
    ),
  ]);
}

/** A PDF header followed by nothing that parses. */
export function malformedPdf(): Uint8Array {
  return new Uint8Array(latin1("%PDF-1.4\nthis is not a PDF body at all\n%%EOF"));
}

export function emptyPdf(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * An encrypted PDF.
 *
 * A standard-security-handler `/Encrypt` dictionary is enough: pdf.js checks it
 * before decrypting any content and raises `PasswordException`.
 */
export function encryptedPdf(): Uint8Array {
  return assemble(
    [
      "<</Type/Catalog/Pages 2 0 R>>",
      "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>",
      `<</Filter/Standard/V 1/R 2/O <${"ab".repeat(32)}>/U <${"cd".repeat(32)}>/P -1>>`,
    ],
    "/Encrypt 4 0 R/ID[<0102> <0304>]",
  );
}

/**
 * A single page declaring an absurd MediaBox.
 *
 * A PDF may claim any page size, so one page can demand a canvas of billions of
 * pixels. This is the decompression-bomb shape the pixel budget exists for.
 */
export function hugePagePdf(): Uint8Array {
  return assemble([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200000 200000]/Contents 4 0 R>>",
    stream("", latin1("")),
  ]);
}

/** A born-digital PDF with `count` pages, for exercising the page limit. */
export function manyPagePdf(count: number): Uint8Array {
  return bornDigitalPdf(
    Array.from({ length: count }, (_, i) => [`PAGE ${i + 1}`]),
  );
}

// ---------------------------------------------------------------------------
// A parser that exists only to prove the wiring
// ---------------------------------------------------------------------------

/**
 * Claims documents carrying `SYNTHETIC_MARKER` and returns a fixed draft.
 *
 * **Not a bank parser and not a template for one.** It reads a marker this
 * repository invented, and it is exported from a `testing` module so it can
 * never be wired into a production registry by accident. Real layout parsers
 * arrive in M2b, against real documents.
 */
export const syntheticParser: StatementParser = {
  id: "synthetic-v1",
  description: "Test-only parser. Claims documents carrying the synthetic marker.",

  supports(document: ExtractedDocument): boolean {
    return document.pages.some((p) => p.text.includes(SYNTHETIC_MARKER));
  },

  async parse(
    document: ExtractedDocument,
    context: ParseContext,
  ): Promise<Result<StatementDraft>> {
    const opening = sen(100_000n);
    const period = isoDate("2026-07-01");
    const end = isoDate("2026-07-31");
    if (!period.ok || !end.ok) throw new Error("fixture built an invalid date");

    return ok<StatementDraft>({
      accountReference: "SAMPLEBANK 0000000000",
      currency: "MYR",
      periodStart: period.value,
      periodEnd: end.value,
      openingBalance: opening,
      closingBalance: opening,
      lines: [],
      source: {
        documentId: context.documentId,
        pageCount: document.pageCount,
      },
    });
  },
};
