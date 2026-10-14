import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TS_SOURCE_FILES, stripComments, walkFiles } from "@/test/structural";

import { isoDate } from "./dates";
import { sen } from "./money";
import { validateStatement, type StatementDraft } from "./statement";
import { buildStatementDraft } from "./testing";

function iso(value: string) {
  const r = isoDate(value);
  if (!r.ok) throw new Error(`bad test date ${value}`);
  return r.value;
}

function rejection(draft: StatementDraft) {
  const r = validateStatement(draft);
  if (r.ok) throw new Error("expected validation to fail");
  return r.failure;
}

describe("a well-formed statement validates", () => {
  it("accepts the synthetic fixture", () => {
    const r = validateStatement(buildStatementDraft());
    expect(r.ok).toBe(true);
  });

  it("accepts a statement with no lines", () => {
    // A dormant account prints a period with no movement. Not an error.
    const draft = buildStatementDraft({ lineCount: 0 });
    expect(validateStatement(draft).ok).toBe(true);
  });
});

describe("structural invariants", () => {
  it("rejects a blank account reference", () => {
    const draft = { ...buildStatementDraft(), accountReference: "   " };
    expect(rejection(draft).detail).toContain("account reference is blank");
  });

  it.each(["myr", "RINGGIT", "", "MY"])("rejects currency %s", (currency) => {
    const draft = { ...buildStatementDraft(), currency };
    expect(rejection(draft).detail).toContain("ISO 4217");
  });

  it("rejects a period that ends before it starts", () => {
    const draft = {
      ...buildStatementDraft(),
      periodStart: iso("2026-07-31"),
      periodEnd: iso("2026-07-01"),
    };
    expect(rejection(draft).detail).toContain("starts after it ends");
  });

  it("rejects a negative debit or credit", () => {
    const base = buildStatementDraft({ lineCount: 3 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, debit: sen(-1n), credit: sen(0n) };
    expect(rejection({ ...base, lines }).detail).toContain("cannot be negative");
  });

  it("rejects a line carrying both a debit and a credit", () => {
    // Both populated means the two columns were read into each other.
    const base = buildStatementDraft({ lineCount: 3 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, debit: sen(100n), credit: sen(100n) };
    expect(rejection({ ...base, lines }).detail).toContain(
      "both a debit and a credit",
    );
  });

  it("rejects a line carrying neither", () => {
    const base = buildStatementDraft({ lineCount: 3 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, debit: sen(0n), credit: sen(0n) };
    expect(rejection({ ...base, lines }).detail).toContain(
      "neither a debit nor a credit",
    );
  });

  it("rejects a page outside the document", () => {
    const base = buildStatementDraft({ lineCount: 3, pageCount: 1 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, source: { ...first.source, page: 4 } };
    expect(rejection({ ...base, lines }).detail).toContain(
      "outside the document",
    );
  });

  it("rejects a line belonging to a different document", () => {
    const base = buildStatementDraft({ lineCount: 3 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = {
      ...first,
      source: { ...first.source, documentId: "another-document" },
    };
    expect(rejection({ ...base, lines }).detail).toContain(
      "different source document",
    );
  });

  it.each([
    ["description", { description: "  " }, "description is blank"],
    ["date token", { dateRaw: "" }, "date token is blank"],
  ])("rejects a blank %s", (_label, patch, fragment) => {
    const base = buildStatementDraft({ lineCount: 3 });
    const first = base.lines[0];
    if (first === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[0] = { ...first, ...patch };
    expect(rejection({ ...base, lines }).detail).toContain(fragment);
  });
});

describe("validation failures name positions, never values", () => {
  it("reports the line and page but not the amount or description", () => {
    const base = buildStatementDraft({ lineCount: 3 });
    const second = base.lines[1];
    if (second === undefined) throw new Error("fixture has no lines");
    const lines = [...base.lines];
    lines[1] = {
      ...second,
      debit: sen(4_242_42n),
      credit: sen(1_337_00n),
      description: "CONFIDENTIAL PAYEE NAME",
    };

    const detail = rejection({ ...base, lines }).detail;
    expect(detail).toContain("line 2");
    expect(detail).toContain("page 1");
    expect(detail).not.toContain("424242");
    expect(detail).not.toContain("CONFIDENTIAL");
  });
});

describe("provenance is preserved", () => {
  it("keeps the printed date token alongside the canonical date", () => {
    const draft = buildStatementDraft({ lineCount: 1 });
    const line = draft.lines[0];
    if (line === undefined) throw new Error("fixture has no lines");
    expect(line.date).toBe("2026-07-13");
    expect(line.dateRaw).toBe("13/07/2026");
  });

  it("locates every line on a page of its own document", () => {
    const draft = buildStatementDraft({ lineCount: 25 });
    for (const line of draft.lines) {
      expect(line.source.documentId).toBe(draft.source.documentId);
      expect(line.source.page).toBeGreaterThanOrEqual(1);
      expect(line.source.page).toBeLessThanOrEqual(draft.source.pageCount);
      expect(line.source.locator).toMatch(/^row:\d+$/);
    }
  });

  it("omits a running balance rather than defaulting it to zero", () => {
    // Absent is not zero: the document simply did not state it.
    const without = buildStatementDraft({ lineCount: 2 });
    expect(without.lines[0]?.runningBalance).toBeUndefined();
    const with_ = buildStatementDraft({ lineCount: 2, withRunningBalances: true });
    expect(with_.lines[0]?.runningBalance).toBeTypeOf("bigint");
  });
});

// ---------------------------------------------------------------------------
// The domain firewall
// ---------------------------------------------------------------------------

describe("no M3 concept reaches the M2 domain", () => {
  /**
   * Vocabulary that belongs to a posting (M3a) or a destination artifact (M3b).
   *
   * Compound tokens where a bare word would collide with TypeScript itself:
   * `export` and `import` are keywords, so only `exportStatus` / `importTemplate`
   * are checked. `posting` is bare because nothing in M2 legitimately uses it.
   */
  const FORBIDDEN = [
    "posting",
    "glaccount",
    "gl_account",
    "taxcode",
    "tax_code",
    "chartofaccount",
    "chart_of_account",
    "suppliercode",
    "supplier_code",
    "customercode",
    "customer_code",
    "sage",
    "sqlaccount",
    "sql_account",
    "importtemplate",
    "import_template",
    "exportstatus",
    "export_status",
    "reviewstatus",
    "review_status",
    "destinationartifact",
    "destination_artifact",
  ];

  const GUARDED = ["lib/domain", "lib/reconcile"];

  it("keeps posting and destination vocabulary out of the domain", () => {
    const offenders: string[] = [];
    for (const guarded of GUARDED) {
      for (const file of walkFiles(join(process.cwd(), ...guarded.split("/")), TS_SOURCE_FILES)) {
        const code = stripComments(readFileSync(file, "utf8")).toLowerCase();
        for (const token of FORBIDDEN) {
          if (code.includes(token)) {
            offenders.push(`${file.replace(process.cwd(), "")}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a non-trivial number of files, so a passing result means something", () => {
    // Guards against the check silently passing because the glob broke.
    const count = GUARDED.reduce(
      (n, g) =>
        n + walkFiles(join(process.cwd(), ...g.split("/")), TS_SOURCE_FILES).length,
      0,
    );
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
