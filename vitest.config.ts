import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests import the same modules the
    // application does, rather than a parallel set of relative paths.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Smoke tests hit real infrastructure and cost money. They are opt-in via
    // `npm run storage:smoke`, never part of `npm test` or CI.
    exclude: ["node_modules/**", ".next/**", "**/*.smoke.test.ts"],
    // Argon2id at OWASP parameters is deliberately slow; several tests hash
    // real passwords through the production path.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each PGlite instance is a full Postgres compiled to WASM, and several
    // tests create one per case. Running files in parallel exhausted memory and
    // killed worker forks once the suite reached eight files -- every file
    // passes in isolation, so this is a resource limit, not a logic failure.
    // Capping forks at 2 was not enough; files run sequentially instead.
    // Revisit if the suite gets slow enough to matter.
    fileParallelism: false,
  },
});
