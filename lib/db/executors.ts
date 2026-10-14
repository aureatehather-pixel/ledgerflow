import type { PGlite } from "@electric-sql/pglite";

import type { SqlExecutor } from "./migrator";

/** PGlite adapter — used by tests. */
export function pgliteExecutor(client: PGlite): SqlExecutor {
  return {
    async exec(sql) {
      await client.exec(sql);
    },
    async query<T>(text: string, params?: unknown[]) {
      const result = await client.query<T>(text, params as never[]);
      return result.rows;
    },
  };
}

/**
 * Adapter for a node-postgres-shaped client (Neon's WebSocket `Client`, or `pg`).
 *
 * Deliberately NOT the neon-http driver: every HTTP request is its own session,
 * so a session-scoped advisory lock would be released the instant it was taken
 * and a transaction could not span statements. Migrations need one connection
 * held across the whole run.
 */
export function nodePostgresExecutor(client: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): SqlExecutor {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T>(text: string, params?: unknown[]) {
      const result = await client.query(text, params);
      return result.rows as T[];
    },
  };
}
