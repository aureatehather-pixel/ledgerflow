import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { pgliteExecutor } from "./executors";
import { migrate } from "./migrator";
import * as schema from "./schema";

export const MIGRATIONS_DIR = join(process.cwd(), "lib", "db", "migrations");

/**
 * An in-process Postgres for tests.
 *
 * This machine has neither Docker nor a local psql, so a conventional test
 * database is not available. PGlite is real Postgres compiled to WASM:
 * constraints, triggers, partial indexes, transactions and advisory locks all
 * behave as they will in Neon.
 *
 * It provisions through the SAME migrator production uses. A harness that built
 * the schema its own way would verify a schema nobody deploys.
 *
 * Each call returns a fresh, isolated database, so tests may run in any order.
 */
export async function createTestDatabase() {
  const client = new PGlite();
  await migrate(pgliteExecutor(client), MIGRATIONS_DIR);
  return {
    db: drizzle(client, { schema }),
    client,
    async close() {
      await client.close();
    },
  };
}

/**
 * Makes every INSERT into `audit_events` fail, at the database.
 *
 * Deliberately NOT a stubbed audit writer. A mock would prove that code calls a
 * function; what has to be proven is that a *transaction rolls back* when the
 * audit row cannot be written, and only a real failure inside the real
 * transaction can show that. This raises from a trigger, so the abort happens
 * where a genuine constraint violation or disk error would.
 *
 * The trigger stays until `allowAuditInserts` removes it; each test gets a
 * fresh database anyway, so forgetting affects nothing else.
 */
export async function failAuditInserts(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE OR REPLACE FUNCTION test_fail_audit_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'injected audit failure';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER test_audit_events_fail_insert BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_fail_audit_insert();
  `);
}

/** Reverses `failAuditInserts`, so one test can show both sides. */
export async function allowAuditInserts(client: PGlite): Promise<void> {
  await client.exec(
    `DROP TRIGGER IF EXISTS test_audit_events_fail_insert ON audit_events;`,
  );
}
