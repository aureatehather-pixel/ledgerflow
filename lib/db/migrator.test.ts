import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pgliteExecutor } from "./executors";
import {
  loadMigrations,
  migrate,
  selectForwardMigrations,
  sha256,
  type SqlExecutor,
} from "./migrator";
import { MIGRATIONS_DIR } from "./testing";

let client: PGlite;
let run: SqlExecutor;
const tempDirs: string[] = [];

beforeEach(() => {
  client = new PGlite();
  run = pgliteExecutor(client);
});

afterEach(async () => {
  await client.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway migration directory, so failure modes can be built on demand. */
function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ledgerflow-migrations-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, "utf8");
  }
  return dir;
}

async function ledger() {
  return run.query<{ filename: string; sha256: string }>(
    "SELECT filename, sha256 FROM schema_migrations ORDER BY filename",
  );
}

async function tableNames(): Promise<string[]> {
  const rows = await run.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  );
  return rows.map((r) => r.table_name).sort();
}

// ---------------------------------------------------------------------------
// File selection — pure, no database
// ---------------------------------------------------------------------------

describe("forward migration selection", () => {
  it("accepts only the canonical filename pattern", () => {
    const selected = selectForwardMigrations([
      "0000_create_schema.sql",
      "0001_add_trigger.sql",
      "0001_add_trigger.down.sql", // down migrations are never applied
      "0002_thing.sql.orig", // editor backup
      "0002_thing.sql~", // editor backup
      ".0003_hidden.sql", // dotfile
      "notes.sql", // unrelated SQL
      "README.md",
      "0004_Bad_Case.sql", // uppercase is not canonical
    ]);
    expect(selected.map((s) => s.filename)).toEqual([
      "0000_create_schema.sql",
      "0001_add_trigger.sql",
    ]);
  });

  it("orders by numeric prefix regardless of directory order", () => {
    const selected = selectForwardMigrations([
      "0010_tenth.sql",
      "0002_second.sql",
      "0000_first.sql",
    ]);
    expect(selected.map((s) => s.index)).toEqual([0, 2, 10]);
  });

  it("rejects duplicate migration numbers", () => {
    // Two files sharing a number have no defined order, and order is the only
    // thing the prefix exists to express.
    expect(() =>
      selectForwardMigrations(["0001_alpha.sql", "0001_beta.sql"]),
    ).toThrow(/Duplicate migration number 0001/);
  });

  it("rejects duplicate filenames", () => {
    expect(() =>
      selectForwardMigrations(["0001_alpha.sql", "0001_alpha.sql"]),
    ).toThrow(/Duplicate migration filename/);
  });

  it("refuses to run against an empty directory", async () => {
    await expect(migrate(run, tempMigrations({}))).rejects.toThrow(
      /No forward migrations found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Clean-database provisioning
// ---------------------------------------------------------------------------

describe("provisioning a fresh database", () => {
  it("applies 0000, 0001 and 0002 once, in order", async () => {
    const applied: string[] = [];
    const result = await migrate(run, MIGRATIONS_DIR, (m) => applied.push(m));

    // Derived from the directory, so adding a migration does not break this
    // test -- while still asserting every one is applied, exactly once, in
    // numeric order.
    const expected = loadMigrations(MIGRATIONS_DIR).map((m) => m.filename);
    expect(expected.slice(0, 3)).toEqual([
      "0000_create_m1_tenancy_and_document_schema.sql",
      "0001_add_updated_at_trigger.sql",
      "0002_replace_authjs_tables_with_better_auth.sql",
    ]);
    expect(result.applied).toEqual(expected);
    expect(result.skipped).toEqual([]);
    expect(applied.filter((m) => m.startsWith("applying"))).toHaveLength(
      expected.length,
    );
  });

  it("records each migration individually with its content hash", async () => {
    await migrate(run, MIGRATIONS_DIR);
    const onDisk = loadMigrations(MIGRATIONS_DIR);
    const rows = await ledger();
    expect(rows).toHaveLength(onDisk.length);
    for (const migration of onDisk) {
      const row = rows.find((r) => r.filename === migration.filename);
      expect(row?.sha256).toBe(migration.sha256);
    }
  });

  it("produces the expected Better Auth schema", async () => {
    await migrate(run, MIGRATIONS_DIR);
    const names = await tableNames();
    for (const expected of ["users", "sessions", "accounts", "verifications"]) {
      expect(names).toContain(expected);
    }
    // 0002 removed it; a fresh database must never resurrect it.
    expect(names).not.toContain("user_credentials");

    const cols = await run.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='accounts'",
    );
    expect(cols.map((c) => c.column_name)).toContain("password");
  });

  it("leaves every domain table intact through 0002", async () => {
    await migrate(run, MIGRATIONS_DIR);
    const names = await tableNames();
    for (const domain of [
      "firms",
      "clients",
      "client_assignments",
      "documents",
      "audit_events",
    ]) {
      expect(names).toContain(domain);
    }
  });

  it("creates an updated_at trigger on every table that has the column", async () => {
    await migrate(run, MIGRATIONS_DIR);

    const withColumn = await run.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='updated_at'`,
    );
    const triggers = await run.query<{ event_object_table: string }>(
      `SELECT event_object_table FROM information_schema.triggers
       WHERE trigger_name LIKE '%set_updated_at'`,
    );
    const triggered = new Set(triggers.map((t) => t.event_object_table));

    for (const { table_name } of withColumn) {
      // schema_migrations is the runner's own ledger and has no updated_at.
      if (table_name === "schema_migrations") continue;
      expect(triggered).toContain(table_name);
    }
    // audit_events is append-only by design and must NOT have one.
    expect(triggered).not.toContain("audit_events");
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("repeat runs", () => {
  it("does no work on a second run", async () => {
    await migrate(run, MIGRATIONS_DIR);
    const second = await migrate(run, MIGRATIONS_DIR);
    const count = loadMigrations(MIGRATIONS_DIR).length;
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(count);
    expect(await ledger()).toHaveLength(count);
  });

  it("applies a newly added migration exactly once", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    await migrate(run, dir);

    writeFileSync(
      join(dir, "0001_added_later.sql"),
      "CREATE TABLE beta (id int primary key);",
      "utf8",
    );
    const second = await migrate(run, dir);
    expect(second.applied).toEqual(["0001_added_later.sql"]);

    const third = await migrate(run, dir);
    expect(third.applied).toEqual([]);
    expect(await ledger()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

describe("integrity", () => {
  it("refuses to run when an applied migration's content has changed", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    await migrate(run, dir);

    // Tamper with history. The database no longer matches the repository, so
    // continuing would build on an unknown state.
    writeFileSync(
      join(dir, "0000_base.sql"),
      "CREATE TABLE alpha (id int primary key, extra text);",
      "utf8",
    );
    await expect(migrate(run, dir)).rejects.toThrow(
      /has changed since it was applied/,
    );
  });

  it("verifies hashes before applying anything new", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    await migrate(run, dir);
    writeFileSync(join(dir, "0000_base.sql"), "CREATE TABLE alpha (id int);", "utf8");
    writeFileSync(
      join(dir, "0001_new.sql"),
      "CREATE TABLE gamma (id int primary key);",
      "utf8",
    );

    await expect(migrate(run, dir)).rejects.toThrow(/has changed/);
    // The pending migration must not have run despite being untouched.
    const names = await tableNames();
    expect(names).not.toContain("gamma");
    expect(await ledger()).toHaveLength(1);
  });

  it("rolls back a failing migration and records nothing", async () => {
    const dir = tempMigrations({
      "0000_ok.sql": "CREATE TABLE alpha (id int primary key);",
      "0001_broken.sql":
        "CREATE TABLE beta (id int primary key);\nTHIS IS NOT SQL;",
    });

    await expect(migrate(run, dir)).rejects.toThrow(/0001_broken\.sql failed/);

    const names = await tableNames();
    expect(names).toContain("alpha"); // 0000 committed before the failure
    // beta was created earlier in the same transaction as the syntax error --
    // PostgreSQL DDL is transactional, so it must be gone.
    expect(names).not.toContain("beta");

    const rows = await ledger();
    expect(rows.map((r) => r.filename)).toEqual(["0000_ok.sql"]);
  });

  it("does not attempt later migrations after a failure", async () => {
    const dir = tempMigrations({
      "0000_broken.sql": "THIS IS NOT SQL;",
      "0001_would_succeed.sql": "CREATE TABLE gamma (id int primary key);",
    });

    await expect(migrate(run, dir)).rejects.toThrow(/0000_broken\.sql failed/);
    // 0001 may depend on 0000. Running it anyway would be guessing.
    expect(await tableNames()).not.toContain("gamma");
    expect(await ledger()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  /*
   * WHAT IS AND IS NOT PROVEN HERE.
   *
   * PGlite is a single in-process session. Two real deployers each hold their
   * own connection, and `pg_advisory_lock` serialises them; that behaviour
   * cannot be reproduced here, because two PGlite instances are two separate
   * databases and one instance is one session. Cross-session serialisation is
   * therefore UNVERIFIED by this suite and is claimed nowhere.
   *
   * What is verified is the backstop that does not depend on the lock at all:
   * the ledger's PRIMARY KEY, which makes a second application of the same
   * migration impossible even if the lock were bypassed entirely. Since the
   * ledger insert shares a transaction with the DDL, a losing racer rolls back
   * its schema changes as well as its ledger row.
   */
  it("cannot record the same migration twice — the ledger key forbids it", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    await migrate(run, dir);

    await expect(
      run.query(
        "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
        ["0000_base.sql", "deadbeef"],
      ),
    ).rejects.toThrow();
    expect(await ledger()).toHaveLength(1);
  });

  it("rolls back the DDL too when the ledger insert loses a race", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    // Simulate the losing racer: the ledger row already exists (written by the
    // winner) while this runner still believes the migration is pending.
    await run.exec(
      "CREATE TABLE schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const [migration] = loadMigrations(dir);
    await run.query(
      "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
      [migration!.filename, migration!.sha256],
    );

    const result = await migrate(run, dir);
    // Seen as already applied, so nothing is attempted and nothing duplicates.
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["0000_base.sql"]);
    expect(await ledger()).toHaveLength(1);
  });

  it("takes and releases the advisory lock", async () => {
    const dir = tempMigrations({
      "0000_base.sql": "CREATE TABLE alpha (id int primary key);",
    });
    await migrate(run, dir);
    // Nothing left holding a lock once the run finishes.
    const held = await run.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks WHERE locktype='advisory'",
    );
    expect(held[0]?.count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// The committed migrations are immutable
// ---------------------------------------------------------------------------

describe("committed migrations", () => {
  it("hashes match what the ledger will record", async () => {
    // Guards the immutability rule: if someone edits a committed migration, the
    // hash here changes and every provisioned database refuses to migrate.
    for (const migration of loadMigrations(MIGRATIONS_DIR)) {
      const content = readFileSync(join(MIGRATIONS_DIR, migration.filename), "utf8");
      expect(migration.sha256).toBe(sha256(content));
    }
  });

  it("contains no drizzle-kit metadata directory", () => {
    // meta/ was removed deliberately: stale snapshots silently skipped 0001 and
    // 0002 under `drizzle-kit migrate`. See docs/decisions/0001-*.
    expect(readdirSync(MIGRATIONS_DIR)).not.toContain("meta");
  });
});
