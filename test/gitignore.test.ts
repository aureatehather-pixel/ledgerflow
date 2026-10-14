import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Acceptance criterion A9, and part of A10.
 *
 * CLAUDE.md non-negotiable 1 says no real client document may ever reach the
 * repository. That rule is enforced by .gitignore, and a rule enforced by a
 * config file nobody tests is a rule that silently stops working the first time
 * someone reorganises it. These assertions are the negative control: they prove
 * the ignore rules REJECT, which is the only thing that matters here. A test
 * that only confirmed source files are trackable would pass just as happily
 * against an empty .gitignore.
 */

/** True when git would ignore `path`. Uses check-ignore, so it tests the real
 *  rules git applies rather than our reading of the file. */
function isIgnored(path: string): boolean {
  try {
    // Exit 0 = ignored, 1 = not ignored, >1 = real error.
    execFileSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    throw error;
  }
}

describe("gitignore denies client documents", () => {
  const documentPaths = [
    "statement.pdf",
    "STATEMENT.PDF",
    "maybank-jan.csv",
    "trial-balance.xlsx",
    "receipt.jpg",
    "receipt.png",
    "scan.tiff",
    "photo.heic",
    "uploads/anything.txt",
    "documents/anything.txt",
    "client-data/anything.txt",
  ];

  it.each(documentPaths)("ignores %s at the repository root", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each(documentPaths)("ignores %s in a nested directory", (path) => {
    expect(isIgnored(`app/some/nested/dir/${path}`)).toBe(true);
  });

  it("has no samples/ exception — a real statement dropped there stays ignored", () => {
    expect(isIgnored("samples/bank-statement.pdf")).toBe(true);
    expect(isIgnored("samples/nested/bank-statement.pdf")).toBe(true);
  });
});

describe("gitignore denies secrets but permits the example", () => {
  it.each([".env", ".env.local", ".env.production", "server.key", "cert.pem"])(
    "ignores %s",
    (path) => {
      expect(isIgnored(path)).toBe(true);
    },
  );

  it("does not ignore .env.example, which carries no real values", () => {
    expect(isIgnored(".env.example")).toBe(false);
  });
});

describe("gitignore does not over-reach", () => {
  it.each(["app/page.tsx", "package.json", "docs/SETUP.md", "test/x.test.ts"])(
    "tracks %s",
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );
});
