/**
 * The documentation-drift gate.
 *
 * `PROJECT-PLAN.md` §6 carries a risk — *documentation drift outpacing the
 * code* — with an explicit reconsideration trigger: *"a third stale-status
 * defect is found despite this — at which point the convention is not working
 * and needs a mechanical check, not more discipline."*
 *
 * That trigger fired on 2026-07-30. Four post-convention stale claims were
 * found in one audit, one of which asserted that a test existed when it did
 * not. This file is the mechanical check the plan called for. It is not a
 * substitute for the convention; it holds the three claim classes that rot
 * fastest and that a human reader stops checking:
 *
 *   1. "this directory exists" / "this directory does not exist"
 *   2. "a test at <path> proves it"
 *   3. "<work> arrives in commit N"
 *
 * **Every check here has a negative control.** A structural test that cannot
 * fail is indistinguishable from `return true`, and a drift gate that silently
 * matches nothing is the exact failure mode it exists to prevent — so the
 * parser is asserted to have found something before its findings are trusted.
 *
 * No network, no database, no credentials.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { TS_AND_MD_FILES, walkFiles } from "./structural";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Reading the layout blocks out of CLAUDE.md
// ---------------------------------------------------------------------------

/**
 * Pulls the fenced block that follows a labelled heading line.
 *
 * Anchored on a substring of the italic label rather than a line number, so
 * reordering the file does not silently return nothing.
 */
function fencedBlockAfter(markdown: string, label: string): string {
  const at = markdown.indexOf(label);
  if (at === -1) {
    throw new Error(`layout label not found in CLAUDE.md: ${label}`);
  }
  const open = markdown.indexOf("```", at);
  const close = markdown.indexOf("```", open + 3);
  if (open === -1 || close === -1) {
    throw new Error(`no fenced block after label: ${label}`);
  }
  return markdown.slice(open + 3, close);
}

/**
 * Turns an indented directory listing into repository-relative paths.
 *
 * Indentation is the nesting, exactly as a reader sees it:
 *
 *     lib/                  -> lib
 *       extract/            -> lib/extract
 *         input/            -> lib/extract/input
 *
 * Only entries ending in `/` are treated as directories; a trailing comment on
 * the same line is ignored. An entry that is already a path (`docs/decisions/`)
 * passes through whole.
 */
function directoriesIn(block: string): string[] {
  const stack: { indent: number; path: string }[] = [];
  const found: string[] = [];

  for (const raw of block.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const token = raw.trim().split(/\s+/)[0];
    if (token === undefined || !token.endsWith("/")) continue;

    const name = token.slice(0, -1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.indent >= indent) stack.pop();
      else break;
    }
    const parent = stack[stack.length - 1];
    const path = parent === undefined ? name : `${parent.path}/${name}`;
    stack.push({ indent, path });
    found.push(path);
  }

  return found;
}

/**
 * Only the leaves are claims.
 *
 * A planned block writes `lib/` and `extract/` purely to show where a planned
 * directory would sit; those parents exist and are not asserted to be absent.
 * The claim "this does not exist yet" belongs to the deepest entry on each
 * branch.
 */
function leavesOnly(paths: readonly string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(`${p}/`)));
}

const CLAUDE_MD = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const IMPLEMENTED = directoriesIn(
  fencedBlockAfter(CLAUDE_MD, "*Implemented —"),
);
const PLANNED = leavesOnly(
  directoriesIn(fencedBlockAfter(CLAUDE_MD, "*Planned.")),
);

function isDirectory(path: string): boolean {
  const full = join(ROOT, ...path.split("/"));
  return existsSync(full) && statSync(full).isDirectory();
}

// ---------------------------------------------------------------------------
// The parser itself, before anything is concluded from it
// ---------------------------------------------------------------------------

describe("the layout parser found something to check", () => {
  /**
   * The failure this guards against is the dangerous one: a heading is reworded,
   * both lists parse as empty, every assertion below passes, and the gate is
   * gone without a single test turning red.
   */
  it("read a non-trivial implemented list", () => {
    expect(IMPLEMENTED.length).toBeGreaterThanOrEqual(10);
    expect(IMPLEMENTED).toContain("lib/auth");
    expect(IMPLEMENTED).toContain("lib/extract/model");
  });

  it("read a non-trivial planned list", () => {
    expect(PLANNED.length).toBeGreaterThanOrEqual(3);
    expect(PLANNED).toContain("lib/classify");
  });

  it("nests by indentation — the negative control", () => {
    const parsed = directoriesIn(
      ["lib/", "  extract/", "    input/    a comment", "docs/decisions/"].join("\n"),
    );
    expect(parsed).toEqual([
      "lib",
      "lib/extract",
      "lib/extract/input",
      "docs/decisions",
    ]);
  });

  it("ignores prose and files, keeping only directory entries", () => {
    expect(directoriesIn("some prose\npackage.json   not a directory\n")).toEqual([]);
  });

  it("refuses a label it cannot find, rather than returning nothing", () => {
    expect(() => fencedBlockAfter(CLAUDE_MD, "*Aspirational —")).toThrow(
      /not found/,
    );
  });

  it("distinguishes a real directory from an absent one", () => {
    expect(isDirectory("lib/auth")).toBe(true);
    expect(isDirectory("lib/no-such-directory")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim class 1 — what exists, and what does not
// ---------------------------------------------------------------------------

describe("CLAUDE.md's layout matches the disk", () => {
  it.each(IMPLEMENTED)("implemented: %s exists", (path) => {
    expect(isDirectory(path)).toBe(true);
  });

  /**
   * The defect that fired the trigger. `lib/extract/model`, `lib/reconcile` and
   * `lib/cost` sat under "none of these exist yet" for a full day after they
   * shipped — a reader deciding where to put extraction code would have been
   * told to create a directory that already held 8,000 lines.
   */
  it.each(PLANNED)("planned: %s does not exist yet", (path) => {
    expect(isDirectory(path)).toBe(false);
  });

  it("keeps the two lists disjoint", () => {
    const overlap = IMPLEMENTED.filter((p) => PLANNED.includes(p));
    expect(overlap).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claim class 2 — "a test at <path> proves it"
// ---------------------------------------------------------------------------

/** Every `<something>.test.ts` path named anywhere in prose or a comment. */
const TEST_PATH_PATTERN = /(?:lib|test|app)[/\\][\w./\\-]*?\.test\.ts/g;

function citedTestPaths(): Map<string, string[]> {
  const cited = new Map<string, string[]>();
  for (const file of walkFiles(ROOT, TS_AND_MD_FILES)) {
    // Documentation and comments make claims; a test file names hypothetical
    // paths on purpose (`gitignore.test.ts` asserts `test/x.test.ts` is tracked),
    // so scanning them would turn a fixture into a false positive.
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(TEST_PATH_PATTERN)) {
      const path = match[0].split("\\").join("/");
      const where = relative(ROOT, file).split(sep).join("/");
      const seen = cited.get(path);
      if (seen) {
        if (!seen.includes(where)) seen.push(where);
      } else cited.set(path, [where]);
    }
  }
  return cited;
}

describe("every cited test file exists", () => {
  const CITED = citedTestPaths();

  it("found citations to check", () => {
    // Same guard as above: an empty map would make the assertion below vacuous.
    expect(CITED.size).toBeGreaterThanOrEqual(5);
  });

  it("names no test file that is absent", () => {
    const missing: string[] = [];
    for (const [path, citedBy] of CITED) {
      if (!existsSync(join(ROOT, ...path.split("/")))) {
        missing.push(`${path} (cited by ${citedBy.join(", ")})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("would catch a renamed test file — the negative control", () => {
    const found = [..."see lib/gone/vanished.test.ts for proof".matchAll(
      TEST_PATH_PATTERN,
    )].map((m) => m[0]);
    expect(found).toEqual(["lib/gone/vanished.test.ts"]);
    expect(existsSync(join(ROOT, "lib", "gone", "vanished.test.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim class 3 — promises about future commits
// ---------------------------------------------------------------------------

/**
 * A comment naming a *future* commit rots the moment that commit lands, and the
 * numbering is now ambiguous anyway: this project has had a commit 6 in M1 and
 * a different commit 6 in M2a. Point at the module that will own the work
 * instead — a module name stays true, or fails a different test when it moves.
 *
 * Backward references ("found in commit 4", "revisited at commit 6") are fine
 * and deliberately not matched: they are history, and history does not rot.
 */
const FORWARD_COMMIT_REFERENCE =
  /commit \d+ (?:will|is going to)\b|(?:arrives?|lands?|begins?) in commit \d+/i;

describe("no comment or reference doc promises a future commit", () => {
  /**
   * `PROJECT-PLAN.md` is deliberately exempt: stating what the next commit will
   * do is that file's entire job, and its progress log is the one place a
   * forward reference is *supposed* to live. `docs/decisions/` is exempt because
   * an ADR is a dated historical record — rewriting one to stay current would
   * destroy the thing it is for.
   *
   * Everything else describes present reality and must not promise anything.
   */
  const EXEMPT = ["PROJECT-PLAN.md", join("docs", "decisions") + sep];

  it("has no forward reference left in code or reference documentation", () => {
    const offenders: string[] = [];
    for (const dir of ["lib", "app", "scripts", "docs"]) {
      const full = join(ROOT, dir);
      if (!existsSync(full)) continue;
      for (const file of walkFiles(full, TS_AND_MD_FILES)) {
        if (file === __filename) continue;
        if (EXEMPT.some((e) => file.includes(e))) continue;
        const text = readFileSync(file, "utf8");
        text.split("\n").forEach((line, i) => {
          if (FORWARD_COMMIT_REFERENCE.test(line)) {
            offenders.push(`${relative(ROOT, file).split(sep).join("/")}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scanned the documentation directory, not only source", () => {
    // Without this, narrowing the loop above to `lib` would leave every doc
    // unchecked and nothing would go red.
    const scanned = walkFiles(join(ROOT, "docs"), TS_AND_MD_FILES).filter((f) =>
      f.endsWith(".md"),
    );
    expect(scanned.length).toBeGreaterThanOrEqual(5);
  });

  it("matches the three real defects it was written for — the negative control", () => {
    // Verbatim from the comments this gate was added to remove.
    expect(
      FORWARD_COMMIT_REFERENCE.test(
        "Retry policy and job state arrive in commit 6, and a record produced here",
      ),
    ).toBe(true);
    expect(
      FORWARD_COMMIT_REFERENCE.test(
        "The idempotency backstop commit 6 will rely on: at most one successful run",
      ),
    ).toBe(true);
    expect(
      FORWARD_COMMIT_REFERENCE.test("statement becomes an image for the vision path in commit 4"),
    ).toBe(false); // wrong-commit references are class 1, not class 3
  });

  it("leaves history alone", () => {
    for (const historical of [
      "Found by the commit 6 audit tests; this path had no malformed-input case.",
      "Revisited at commit 6, which is when the fourth use was expected to settle",
      "Write-level access (consumed by commit 5)",
    ]) {
      expect(FORWARD_COMMIT_REFERENCE.test(historical)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Claim class 4: "see <document>"
// ---------------------------------------------------------------------------

/**
 * Every repository document named anywhere in prose or a comment: a `docs/`
 * path, an upper-case root document such as `SETUP.md`, or the planning
 * document by its bare name.
 */
const DOC_REFERENCE = /docs\/[\w./-]+\.md|\b[A-Z][A-Z0-9-]*\.md\b|\bPROJECT-PLAN\b/g;

/**
 * Material that lives outside this repository: the author's private agent
 * operating system. A public reader cannot follow these, so none may appear.
 */
const PRIVATE_REFERENCE = /execution-os|~\/\.(?:claude|codex)\b|\bcore\.md\b/;

function resolvesFrom(citingFile: string, reference: string): boolean {
  if (reference === "PROJECT-PLAN") return existsSync(join(ROOT, "PROJECT-PLAN.md"));
  return [ROOT, join(ROOT, "docs"), join(citingFile, "..")].some((base) =>
    existsSync(join(base, ...reference.split("/"))),
  );
}

describe("every cited document exists", () => {
  /**
   * `docs/decisions/` is exempt for the reason given above: an ADR is a dated
   * record and keeps the citations it was written with. Everything else is
   * current documentation, and a pointer a reader cannot follow is drift.
   */
  const scanned = walkFiles(ROOT, TS_AND_MD_FILES).filter(
    (f) => !f.includes(join("docs", "decisions") + sep) && f !== __filename,
  );

  it("found citations to check", () => {
    const count = scanned.reduce(
      (n, f) => n + [...readFileSync(f, "utf8").matchAll(DOC_REFERENCE)].length,
      0,
    );
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it("names no document that is absent", () => {
    const missing: string[] = [];
    for (const file of scanned) {
      const where = relative(ROOT, file).split(sep).join("/");
      for (const match of readFileSync(file, "utf8").matchAll(DOC_REFERENCE)) {
        if (!resolvesFrom(file, match[0])) missing.push(`${match[0]} (cited by ${where})`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("points nowhere outside the repository", () => {
    const offenders = scanned
      .filter((f) => PRIVATE_REFERENCE.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("would catch a withdrawn document (the negative control)", () => {
    const found = [..."see docs/GONE.md and PROJECT-PLAN §5".matchAll(DOC_REFERENCE)].map(
      (m) => m[0],
    );
    expect(found).toEqual(["docs/GONE.md", "PROJECT-PLAN"]);
    expect(resolvesFrom(join(ROOT, "README.md"), "docs/GONE.md")).toBe(false);
    expect(resolvesFrom(join(ROOT, "README.md"), "docs/SETUP.md")).toBe(true);
    expect(PRIVATE_REFERENCE.test("load ~/execution-os/os/core.md")).toBe(true);
  });
});
