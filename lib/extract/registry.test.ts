import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TS_FILES, walkFiles } from "@/test/structural";

import type { ExtractedDocument, StatementParser } from "./port";
import { EMPTY_PARSER_REGISTRY, createParserRegistry } from "./registry";
import { SYNTHETIC_MARKER, syntheticParser } from "./testing";

function doc(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    documentId: "00000000-0000-7000-8000-0000000000bb",
    pageCount: 1,
    kind: "text-layer",
    pages: [{ page: 1, text: SYNTHETIC_MARKER, itemCount: 1 }],
    ...overrides,
  };
}

function stub(id: string, accepts: boolean): StatementParser {
  return {
    id,
    description: `stub ${id}`,
    supports: () => accepts,
    parse: syntheticParser.parse.bind(syntheticParser),
  };
}

describe("selection", () => {
  it("returns the first parser that claims the document", () => {
    const registry = createParserRegistry([
      stub("never", false),
      stub("first-match", true),
      stub("second-match", true),
    ]);
    const selected = registry.select(doc());
    expect(selected.ok && selected.value.id).toBe("first-match");
  });

  it("is deterministic across repeated calls", () => {
    const registry = createParserRegistry([stub("a", true), stub("b", true)]);
    const ids = Array.from({ length: 20 }, () => {
      const r = registry.select(doc());
      return r.ok ? r.value.id : "FAILED";
    });
    expect(new Set(ids)).toEqual(new Set(["a"]));
  });

  it("depends on registration order, not on import order", () => {
    // The reason the registry is injected rather than a global that parsers
    // register into on import: with a global, adding an unrelated import to a
    // module can change which parser wins, and that surfaces as a wrong number.
    const forward = createParserRegistry([stub("a", true), stub("b", true)]);
    const reversed = createParserRegistry([stub("b", true), stub("a", true)]);

    const first = forward.select(doc());
    const second = reversed.select(doc());
    expect(first.ok && first.value.id).toBe("a");
    expect(second.ok && second.value.id).toBe("b");
  });

  it("routes a real document to the parser that claims it", () => {
    const registry = createParserRegistry([stub("never", false), syntheticParser]);
    const selected = registry.select(doc());
    expect(selected.ok && selected.value.id).toBe("synthetic-v1");
  });

  it("does not claim a document without the marker", () => {
    const registry = createParserRegistry([syntheticParser]);
    const other = doc({ pages: [{ page: 1, text: "SOMETHING ELSE", itemCount: 1 }] });
    expect(registry.select(other).ok).toBe(false);
  });
});

describe("unsupported documents", () => {
  it("returns a typed failure naming the shape, not the content", () => {
    const registry = createParserRegistry([stub("never", false)]);
    const r = registry.select(
      doc({ pages: [{ page: 1, text: "ACCOUNT 8888888888", itemCount: 1 }] }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("UNSUPPORTED_INPUT");
      expect(r.failure.detail).toContain("kind=text-layer");
      expect(r.failure.detail).toContain("candidates=1");
      expect(r.failure.detail).not.toContain("8888888888");
    }
  });

  it("treats an empty registry as unsupported, which is today's honest state", () => {
    // No layout parser exists until M2b sees real documents.
    const r = EMPTY_PARSER_REGISTRY.select(doc());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("UNSUPPORTED_INPUT");
  });

  it("reports an image-only document as unsupported by a text parser", () => {
    const registry = createParserRegistry([syntheticParser]);
    const r = registry.select(doc({ kind: "image-only", pages: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("kind=image-only");
  });
});

describe("construction", () => {
  it("rejects duplicate ids", () => {
    expect(() => createParserRegistry([stub("dup", true), stub("dup", false)])).toThrow(
      /duplicate parser id: dup/,
    );
  });

  it("rejects a blank id", () => {
    expect(() => createParserRegistry([stub("  ", true)])).toThrow(/must not be blank/);
  });

  it("is immutable", () => {
    const registry = createParserRegistry([stub("a", true)]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.parsers)).toBe(true);
  });

  it("does not observe later mutation of the array it was given", () => {
    const parsers = [stub("a", true)];
    const registry = createParserRegistry(parsers);
    parsers.push(stub("b", true));
    expect(registry.parsers).toHaveLength(1);
  });

  it("looks a parser up by id", () => {
    const registry = createParserRegistry([syntheticParser]);
    expect(registry.byId("synthetic-v1")).toBe(syntheticParser);
    expect(registry.byId("nope")).toBeUndefined();
  });
});

describe("parsers emit candidates, not validated statements", () => {
  it("returns a draft the domain still has to validate", async () => {
    const r = await syntheticParser.parse(doc(), { documentId: "doc-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source.documentId).toBe("doc-1");
      // A draft carries no proof of validity: `validateStatement` is the only
      // source of a `Statement`, and it lives in the domain.
      expect("__validated" in r.value).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider containment
// ---------------------------------------------------------------------------

describe("PDF libraries stay inside lib/extract/input", () => {
  const ALLOWED = ["lib\\extract\\input\\", "lib/extract/input/"];

  /** This file names both packages in the case list below, so it must exempt
   *  itself -- and only itself. Every other test stays under the rule, because
   *  a test reaching for pdf.js directly would mean the boundary is wrong. */
  const SELF = fileURLToPath(import.meta.url);

  it.each(["pdfjs-dist", "@napi-rs/canvas"])(
    "no file outside the input path imports %s",
    (pkg) => {
      const offenders: string[] = [];
      for (const file of walkFiles(process.cwd(), TS_FILES)) {
        if (file === SELF) continue;
        if (ALLOWED.some((a) => file.includes(a))) continue;
        const code = readFileSync(file, "utf8");
        if (code.includes(`"${pkg}`) || code.includes(`'${pkg}`)) {
          offenders.push(file.replace(process.cwd(), ""));
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it("keeps the domain free of PDF vocabulary", () => {
    // The parser port is provider-neutral so a bank parser written in M2b never
    // has to be revisited when pdf.js moves an API.
    for (const file of walkFiles(join(process.cwd(), "lib", "domain"), TS_FILES)) {
      const code = readFileSync(file, "utf8");
      expect(code).not.toMatch(/pdfjs|canvas|getViewport|getTextContent/i);
    }
  });
});
