/**
 * The `prebuild` preflight: is Next's native compiler installed for THIS machine?
 *
 * `next build` uses Turbopack, which needs the platform's native SWC binary
 * (`@next/swc-<platform>-<arch>`, an optional dependency of `next`). When that
 * package is absent, Next tries to download one from the npm registry at build
 * time, and if that fails it falls back to a WASM compiler Turbopack cannot use.
 * Reproduced on 2026-10-14 with the registry unreachable: `next build` printed an
 * unhandled `fetch failed`, wrote no `.next/` at all, and **exited 0**. A build
 * that reports success without producing anything is the failure this exists
 * to prevent, and a build that quietly fetches an unlocked binary is not
 * reproducible even when it works.
 *
 * The package goes missing in two ways:
 *   1. optional dependencies were omitted (`--omit=optional`,
 *      `npm_config_omit`). The committed `.npmrc` sets `include=optional`, which
 *      npm ranks above any `omit`, so this one is closed at install time.
 *   2. `node_modules` was installed on a different OS or CPU and copied here.
 *      Nothing at install time can see that; this check does.
 *
 * The expected package names come from `package-lock.json`, never from a list
 * written here: the lockfile already records which `@next/swc-*` package serves
 * which `os`/`cpu`, and a second copy of that table would go stale on the next
 * Next.js upgrade.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SWC_PREFIX = "node_modules/@next/swc-";

interface LockEntry {
  readonly version?: string;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

export interface Lockfile {
  readonly packages?: Readonly<Record<string, LockEntry>>;
}

export interface Machine {
  readonly platform: string;
  readonly arch: string;
  /** Installed version of a package, or undefined when it is not installed. */
  readonly installedVersion: (name: string) => string | undefined;
}

/**
 * Returns a human-readable problem, or `null` when the build may proceed.
 *
 * Pure: the lockfile and the machine are passed in, so every branch is tested
 * without touching the real `node_modules`.
 */
export function findNativeCompilerProblem(lock: Lockfile, machine: Machine): string | null {
  const swc = Object.entries(lock.packages ?? {})
    .filter(([path]) => path.startsWith(SWC_PREFIX))
    .map(([path, entry]) => ({ name: path.slice("node_modules/".length), entry }));

  if (swc.length === 0) {
    // Fail loud rather than pass vacuously: the lockfile no longer has the shape
    // this check reads, so it is checking nothing.
    return "package-lock.json lists no @next/swc-* packages; this preflight no longer matches how Next ships its compiler and must be revisited.";
  }

  const candidates = swc.filter(
    ({ entry }) =>
      (entry.os ?? []).includes(machine.platform) && (entry.cpu ?? []).includes(machine.arch),
  );

  // No native build exists for this platform. Next uses WASM by design there,
  // which is not the failure this check is for.
  if (candidates.length === 0) return null;

  const satisfied = candidates.some(
    ({ name, entry }) => machine.installedVersion(name) === entry.version,
  );
  if (satisfied) return null;

  const expected = candidates.map(({ name, entry }) => `${name}@${entry.version}`).join(" or ");
  const found = candidates
    .map(({ name }) => ({ name, version: machine.installedVersion(name) }))
    .filter((c) => c.version !== undefined)
    .map((c) => `${c.name}@${c.version}`);

  return [
    `Next.js's native compiler for ${machine.platform}/${machine.arch} is not installed.`,
    `  expected: ${expected}`,
    `  found:    ${found.length > 0 ? found.join(", ") : "nothing"}`,
    "",
    "Without it, `next build` downloads a compiler at build time or falls back to",
    "WASM, which Turbopack cannot use. Usual causes: node_modules was installed on a",
    "different OS/CPU and copied here, or optional dependencies were omitted.",
    "",
    "Fix: delete node_modules and run `npm ci` on this machine.",
  ].join("\n");
}

function installedVersionIn(root: string): (name: string) => string | undefined {
  return (name) => {
    const manifest = join(root, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(manifest)) return undefined;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
    return parsed.version;
  };
}

function main(): void {
  const root = process.cwd();
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Lockfile;
  const problem = findNativeCompilerProblem(lock, {
    platform: process.platform,
    arch: process.arch,
    installedVersion: installedVersionIn(root),
  });
  if (problem !== null) {
    console.error(problem);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
