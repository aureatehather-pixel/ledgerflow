import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The migration runner.
 *
 * Ordered `.sql` files are this project's only migration authority. Drizzle
 * Kit's snapshot mechanism was retired because it could not represent the
 * approved hand-written migrations — see docs/decisions/0001-sql-migrations-as-
 * the-single-authority.md. Nothing here reads `_journal.json` or a snapshot.
 *
 * Deliberately small. This is a migration *runner*, not a migration framework:
 * no templating, no plugins, no rollback orchestration. Down migrations stay
 * manual and development-only.
 */

/** Canonical forward migration filename: `NNNN_lower_snake_name.sql`. */
const FORWARD_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * Session-scoped advisory lock key. Any constant works provided every deployer
 * uses the same one; this is `ledgerflow-migrations` truncated from its SHA-256.
 * Chosen over a table lock because it is held for the whole run, needs no
 * schema, and is released automatically if the connection dies mid-migration.
 */
const ADVISORY_LOCK_KEY = 7_263_845_190_223_471n;

export interface SqlExecutor {
  /** Multi-statement DDL. No parameters. */
  exec(sql: string): Promise<void>;
  /** Single parameterised statement. */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

export interface Migration {
  filename: string;
  index: number;
  sha256: string;
  sql: string;
}

export interface MigrationRecord {
  filename: string;
  sha256: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Selects and orders forward migrations from a list of filenames.
 *
 * Pure, so the failure modes can be tested without a filesystem. Anything that
 * is not a canonical forward migration is ignored rather than guessed at:
 * `.down.sql`, editor backups (`~`, `.orig`, `.bak`), dotfiles and unrelated
 * SQL all fail the pattern.
 */
export function selectForwardMigrations(filenames: string[]): {
  filename: string;
  index: number;
}[] {
  const selected: { filename: string; index: number }[] = [];
  const seenFilenames = new Set<string>();
  const seenIndexes = new Map<number, string>();

  for (const filename of filenames) {
    const match = FORWARD_PATTERN.exec(filename);
    if (!match) continue;

    if (seenFilenames.has(filename)) {
      throw new Error(`Duplicate migration filename: ${filename}`);
    }
    seenFilenames.add(filename);

    const index = Number(match[1]);
    const clash = seenIndexes.get(index);
    if (clash !== undefined) {
      // Two files sharing a number have no defined order between them, and the
      // order is the only thing a numeric prefix exists to express.
      throw new Error(
        `Duplicate migration number ${match[1]}: ${clash} and ${filename}`,
      );
    }
    seenIndexes.set(index, filename);
    selected.push({ filename, index });
  }

  // Lexical order over a fixed-width numeric prefix is numeric order.
  selected.sort((a, b) => a.filename.localeCompare(b.filename));
  return selected;
}

export function loadMigrations(directory: string): Migration[] {
  return selectForwardMigrations(readdirSync(directory)).map(
    ({ filename, index }) => {
      const sql = readFileSync(join(directory, filename), "utf8");
      return { filename, index, sha256: sha256(sql), sql };
    },
  );
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies every pending migration, in order, exactly once.
 *
 * Guarantees:
 *   - an advisory lock serialises concurrent deployers;
 *   - each migration runs inside a transaction together with its ledger insert,
 *     so a failure records nothing and leaves nothing half-applied (PostgreSQL
 *     DDL is transactional);
 *   - a migration whose content has changed since it was applied aborts the
 *     run before anything else happens;
 *   - a failure stops the run — later migrations are never attempted, because
 *     they may depend on the one that failed.
 */
export async function migrate(
  run: SqlExecutor,
  directory: string,
  log: (message: string) => void = () => {},
): Promise<MigrateResult> {
  const migrations = loadMigrations(directory);
  if (migrations.length === 0) {
    throw new Error(`No forward migrations found in ${directory}`);
  }

  // Held for the whole run. A second deployer blocks here rather than racing.
  await run.query("SELECT pg_advisory_lock($1)", [
    ADVISORY_LOCK_KEY.toString(),
  ]);

  try {
    await run.exec(LEDGER_DDL);

    const recorded = new Map(
      (
        await run.query<MigrationRecord>(
          "SELECT filename, sha256 FROM schema_migrations",
        )
      ).map((row) => [row.filename, row.sha256]),
    );

    // Verify everything already applied BEFORE applying anything new. A tampered
    // migration means the database no longer matches the repository, and
    // continuing would build on an unknown state.
    for (const migration of migrations) {
      const previous = recorded.get(migration.filename);
      if (previous !== undefined && previous !== migration.sha256) {
        throw new Error(
          `Migration ${migration.filename} has changed since it was applied ` +
            `(recorded ${previous.slice(0, 12)}…, found ${migration.sha256.slice(0, 12)}…). ` +
            `Committed migrations are immutable; add a new forward migration instead.`,
        );
      }
    }

    const result: MigrateResult = { applied: [], skipped: [] };

    for (const migration of migrations) {
      if (recorded.has(migration.filename)) {
        result.skipped.push(migration.filename);
        continue;
      }

      log(`applying ${migration.filename}`);
      await run.exec("BEGIN");
      try {
        await run.exec(migration.sql);
        // Same transaction as the DDL: the ledger cannot disagree with reality.
        // The PRIMARY KEY is also the last line of defence against double
        // application if the advisory lock were ever bypassed.
        await run.query(
          "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
          [migration.filename, migration.sha256],
        );
        await run.exec("COMMIT");
      } catch (error) {
        await run.exec("ROLLBACK");
        // Stop here. Later migrations may assume this one succeeded.
        throw new Error(
          `Migration ${migration.filename} failed and was rolled back: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      result.applied.push(migration.filename);
    }

    log(
      result.applied.length === 0
        ? `up to date (${result.skipped.length} already applied)`
        : `applied ${result.applied.length} migration(s)`,
    );
    return result;
  } finally {
    await run.query("SELECT pg_advisory_unlock($1)", [
      ADVISORY_LOCK_KEY.toString(),
    ]);
  }
}
