/**
 * Shared machinery for structural tests.
 *
 * Several boundaries in this project are held by *structural* tests — assertions
 * about the source tree rather than about behaviour: only `lib/auth` interprets
 * sessions, only `lib/extract/input` imports a PDF library, only
 * `lib/extract/model` reaches a provider, only `lib/audit` writes
 * `audit_events`, and `CLAUDE.md`'s layout matches the disk.
 *
 * Each of those grew its own copy of the same directory walk — six by the time
 * `test/layout.test.ts` landed, one of which had quietly dropped the
 * `node_modules` skip and was safe only because of where it was called. Six
 * copies of a traversal is the rule of three well past its limit, so the walk
 * lives here once.
 *
 * **The filter stays at the call site.** The traversal is genuinely shared; what
 * counts as a file worth reading is not — one test needs markdown, another must
 * exclude test files, a third must include them. Pushing that decision in here
 * would produce a helper parameterised on nearly everything it does, which is
 * the trade `lib/authz/clients.ts` declines for the same reason.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories no structural test should ever descend into. */
const SKIP = new Set(["node_modules", ".next", ".git"]);

/**
 * Every file under `dir`, recursively, whose name matches `match`.
 *
 * The skip list is not optional. A structural scan that walks `node_modules`
 * does not merely run slowly — it finds "offenders" in third-party code and
 * reports a boundary violation that does not exist.
 */
export function walkFiles(dir: string, match: RegExp, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, match, acc);
    else if (match.test(entry)) acc.push(full);
  }
  return acc;
}

/** TypeScript sources, tests included. */
export const TS_FILES = /\.tsx?$/;

/**
 * TypeScript sources excluding tests.
 *
 * The distinction matters more than it looks: a test file legitimately *names*
 * the thing it forbids — `registry.test.ts` lists `pdfjs-dist` in its own case
 * list — so a scan that includes tests must exempt itself, and one that excludes
 * them need not.
 */
export const TS_SOURCE_FILES = /(?<!\.test)\.tsx?$/;

/** TypeScript sources and markdown, for scans over claims as well as code. */
export const TS_AND_MD_FILES = /\.(tsx?|md)$/;

/**
 * Source with comments removed.
 *
 * Comments *describe* these rules — often at length, and necessarily naming the
 * thing being forbidden — so only code can break one. Stripping first is what
 * lets a module document its own boundary without failing the test that holds
 * it.
 *
 * Deliberately naive: no string-literal or regex-literal awareness. It is enough
 * for the assertions here, all of which look for an import or an identifier, and
 * a real parser would be a dependency added to make a test slightly tidier. The
 * `[^:]` guard keeps it from eating the `//` in a URL.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
