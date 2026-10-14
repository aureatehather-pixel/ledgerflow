import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findNativeCompilerProblem, type Lockfile } from "./check-native-compiler.ts";

const LOCK: Lockfile = {
  packages: {
    "": {},
    "node_modules/next": { version: "16.2.12" },
    "node_modules/@next/swc-darwin-arm64": { version: "16.2.12", os: ["darwin"], cpu: ["arm64"] },
    "node_modules/@next/swc-linux-x64-gnu": { version: "16.2.12", os: ["linux"], cpu: ["x64"] },
    "node_modules/@next/swc-linux-x64-musl": { version: "16.2.12", os: ["linux"], cpu: ["x64"] },
    "node_modules/@next/swc-win32-x64-msvc": { version: "16.2.12", os: ["win32"], cpu: ["x64"] },
  },
};

function machine(platform: string, arch: string, installed: Record<string, string>) {
  return { platform, arch, installedVersion: (name: string) => installed[name] };
}

describe("findNativeCompilerProblem", () => {
  it("passes when this platform's compiler is installed at the locked version", () => {
    expect(
      findNativeCompilerProblem(
        LOCK,
        machine("darwin", "arm64", { "@next/swc-darwin-arm64": "16.2.12" }),
      ),
    ).toBeNull();
  });

  it("accepts either libc variant on Linux", () => {
    expect(
      findNativeCompilerProblem(
        LOCK,
        machine("linux", "x64", { "@next/swc-linux-x64-musl": "16.2.12" }),
      ),
    ).toBeNull();
  });

  /**
   * The audit failure: a macOS build whose node_modules held only another
   * platform's compiler. This is the negative control. A preflight that cannot
   * fail here is `return null`.
   */
  it("refuses node_modules installed for a different platform", () => {
    const problem = findNativeCompilerProblem(
      LOCK,
      machine("darwin", "arm64", { "@next/swc-win32-x64-msvc": "16.2.12" }),
    );
    expect(problem).toContain("darwin/arm64");
    expect(problem).toContain("@next/swc-darwin-arm64@16.2.12");
    expect(problem).toContain("found:    nothing");
    expect(problem).toContain("npm ci");
  });

  it("refuses a compiler left behind by a different Next version", () => {
    const problem = findNativeCompilerProblem(
      LOCK,
      machine("linux", "x64", { "@next/swc-linux-x64-gnu": "16.0.0" }),
    );
    expect(problem).toContain("found:    @next/swc-linux-x64-gnu@16.0.0");
  });

  it("does not block a platform Next ships no native compiler for", () => {
    expect(findNativeCompilerProblem(LOCK, machine("freebsd", "x64", {}))).toBeNull();
  });

  it("fails loud when the lockfile has no compiler entries to check", () => {
    expect(
      findNativeCompilerProblem({ packages: {} }, machine("linux", "x64", {})),
    ).toMatch(/no @next\/swc-\* packages/);
  });
});

describe("the committed lockfile and npm configuration", () => {
  const lock = JSON.parse(
    readFileSync(join(process.cwd(), "package-lock.json"), "utf8"),
  ) as Lockfile;

  /**
   * The platforms the README names as supported. If a Next upgrade or a lockfile
   * regenerated with `--os`/`--cpu` dropped one, a clean install there would
   * fall back to a build-time download, and this goes red first.
   */
  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ])("locks a native compiler for %s/%s", (platform, arch) => {
    const problem = findNativeCompilerProblem(lock, machine(platform, arch, {}));
    expect(problem).toContain("is not installed");
  });

  it("keeps optional dependencies included regardless of omit settings", () => {
    const npmrc = readFileSync(join(process.cwd(), ".npmrc"), "utf8");
    expect(npmrc.split(/\r?\n/).map((l) => l.trim())).toContain("include=optional");
  });

  it("runs the preflight before every production build", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["prebuild"]).toContain("scripts/check-native-compiler.ts");
  });
});
