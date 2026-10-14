import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Live smoke tests. Opt-in only: `npm run storage:smoke`.
 *
 * Separate from vitest.config.ts because these reach real infrastructure, cost
 * money, and must never run in CI by accident.
 */

/** Reads .env.local without a dotenv dependency. Values are passed to the test
 *  process and never printed. */
function loadLocalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value) env[trimmed.slice(0, eq).trim()] = value;
    }
  } catch {
    // Absent file is fine; the test asserts configuration and fails clearly.
  }
  return env;
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["**/*.smoke.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    env: loadLocalEnv(),
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential: the checks share one bucket and assert on object counts.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
