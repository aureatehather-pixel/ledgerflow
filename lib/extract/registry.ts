/**
 * Parser selection.
 *
 * Immutable and injected, never a global mutable singleton. A module-level
 * registry that parsers register into on import makes selection depend on import
 * order, which means a test that imports one extra module can change which
 * parser handles a document -- and the failure shows up as a wrong number, not
 * as an error. Here the caller passes the set explicitly and gets a frozen
 * object back.
 *
 * Selection is first-match in registration order. That is a deliberate choice
 * over "most specific wins" or a score: ranking needs a comparable notion of
 * specificity across layouts nobody has seen yet, and inventing one now would be
 * an abstraction over zero implementations. Order is the tie-break, it is
 * documented, and `select` is pure -- the same registry and document always
 * choose the same parser.
 */

import { fail, ok, type Result } from "@/lib/domain/failures";
import type { ExtractedDocument, StatementParser } from "./port";

export interface ParserRegistry {
  readonly parsers: readonly StatementParser[];
  /** First parser whose `supports` accepts the document, else a typed failure. */
  select(document: ExtractedDocument): Result<StatementParser>;
  byId(id: string): StatementParser | undefined;
}

/**
 * Builds a registry.
 *
 * Duplicate ids throw at construction rather than returning a failure: this is
 * a programming error in the wiring, discovered once at startup, not a runtime
 * condition a caller can handle. A duplicate would also make `byId` ambiguous,
 * and run records store the id.
 */
export function createParserRegistry(
  parsers: readonly StatementParser[],
): ParserRegistry {
  const seen = new Set<string>();
  for (const parser of parsers) {
    if (parser.id.trim().length === 0) {
      throw new Error("parser id must not be blank");
    }
    if (seen.has(parser.id)) {
      throw new Error(`duplicate parser id: ${parser.id}`);
    }
    seen.add(parser.id);
  }

  const frozen = Object.freeze([...parsers]);
  const index = new Map(frozen.map((p) => [p.id, p]));

  return Object.freeze({
    parsers: frozen,
    select(document: ExtractedDocument): Result<StatementParser> {
      for (const parser of frozen) {
        if (parser.supports(document)) return ok(parser);
      }
      // Names the document's shape, never its content.
      return fail(
        "UNSUPPORTED_INPUT",
        `no parser claims this document (kind=${document.kind}, pages=${document.pageCount}, candidates=${frozen.length})`,
      );
    },
    byId(id: string) {
      return index.get(id);
    },
  });
}

/** An empty registry. Every document is unsupported, which is the honest state
 *  until M2b adds a real layout parser. */
export const EMPTY_PARSER_REGISTRY: ParserRegistry = createParserRegistry([]);
