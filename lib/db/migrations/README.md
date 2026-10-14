# Migrations — the contract

**Ordered `.sql` files in this directory are the executable migration source of truth.** There is no
snapshot, no journal, and no generated metadata. `drizzle-kit` is not installed and is not used by this
project; the reasoning is in [`docs/decisions/0001-sql-migrations-as-the-single-authority.md`](../../../docs/decisions/0001-sql-migrations-as-the-single-authority.md).

## The rules

1. **Numeric prefixes define execution order.** `NNNN_lower_snake_name.sql`. Anything not matching that
   pattern is ignored by the runner — including `.down.sql`, editor backups and unrelated SQL.
2. **Committed forward migrations are immutable.** Once a migration is in a commit, its bytes never change.
   The runner records each file's SHA-256 and **refuses to migrate** if a recorded file's content differs.
3. **Every schema change requires a new forward migration.** Never edit an old one to add a column.
4. **The only exception** is an unreleased-history correction — a migration that has not been applied to any
   deployed database — and it must be explicitly approved before any deployment. Changing a file that any
   real database has already applied will break that database's next migration by design.
5. **Down migrations are development-only** and may be destructive where documented. They are never applied
   automatically. Read the header of `0002_..._down.sql` before running it: it permanently deletes password
   hashes.
6. **`schema.ts` describes the expected end-state** for types and queries. **The SQL is the deployment
   authority.** When they disagree, the SQL is what the database will have.

## Applying migrations

One command, everywhere — the env file is named explicitly, so the target database is never implied:

```sh
node --env-file=.env.local --experimental-strip-types scripts/migrate.ts
```

- **Local development** — same command. Name a different env file to migrate a different database.
- **CI** — `npm run db:migrate` is the right form there, because CI already supplies `DATABASE_URL` in the
  process environment. It needs no TTY and is safe to run on every deploy.
- **Fresh Neon provisioning** — same command. It creates the ledger itself and applies everything in order.

`npm run db:migrate` runs `scripts/migrate.ts` with no env file of its own, so it is valid **only when
`DATABASE_URL` is already present in the process environment**. Nothing here loads `.env.local` for it, and
nothing should: a default connection string is how a development database ends up being migrated instead of
the intended one (`scripts/migrate.ts:19-21`). Do not put a connection string on the command line either —
it lands in shell history.

Safe to run repeatedly (a second run does nothing) and safe to run concurrently (an advisory lock
serialises deployers; the ledger's primary key is the backstop).

## The ledger

The runner maintains one table, created on first run:

```sql
CREATE TABLE schema_migrations (
  filename    text PRIMARY KEY,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
```

Each migration is applied inside a transaction **together with its ledger row**, so the ledger cannot
disagree with the schema: a failure rolls back both, and the run stops rather than attempting later
migrations that may depend on the failed one.

## Current migrations

| File | What it does |
|---|---|
| `0000_create_m1_tenancy_and_document_schema.sql` | Tenancy, clients, client assignments, documents, audit events |
| `0001_add_updated_at_trigger.sql` | `set_updated_at()` and its triggers |
| `0002_replace_authjs_tables_with_better_auth.sql` | Replaces the Auth.js-shaped auth tables with Better Auth's model |
| `0003_add_document_upload_state.sql` | `documents.status` (`pending`/`ready`/`failed`) plus the retry-idempotence index |
| `0004_make_audit_events_append_only.sql` | Trigger rejecting every `UPDATE` on `audit_events`, plus `actor_user_id` FK changed SET NULL → **RESTRICT** (the two are inseparable — see the file header). `DELETE` is left open for M5 retention |
| `0005_create_m2_extraction_schema.sql` | M2a extraction: `extraction_runs`, `statements`, `statement_lines`, `provider_calls`. Tenant isolation is relational — every child reaches its parent through a **composite foreign key including `firm_id`**, anchored by a new `UNIQUE (id, firm_id)` on `documents`. Money is `bigint` (sen and microcents) |
