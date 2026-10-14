# 0001 — Ordered SQL files are the single migration authority

**Status** — Accepted · 2026-07-29

**Context** — Migrations `0001` and `0002` were written by hand: `0001` defines a `plpgsql` trigger
function, and `0002` required explicit `DROP`/`CREATE` to replace the Auth.js-shaped auth tables, where
Drizzle Kit's generator would have emitted `ALTER` statements. Neither could be produced by
`drizzle-kit generate`, so neither was ever registered in `meta/_journal.json` and no snapshot described
the schema they produced.

That left the repository with metadata claiming the schema was as of `0000`. Two consequences, both
verified against `drizzle-kit@0.31.10` on 2026-07-29:

- **`drizzle-kit migrate` would have applied only `0000`.** The journal listed one entry. A fresh Neon
  database provisioned with the obvious command would have had no `updated_at` triggers and the
  *superseded* auth tables — authentication failing in a way that looks like an application bug.
- **`drizzle-kit generate` could not be repaired.** `generate --custom` writes the previous snapshot
  forward unchanged (`0003_snapshot.json` came out a byte-copy of `0000_snapshot.json`, still containing
  `user_credentials`, still missing `verifications`), which is correct for an empty migration and useless
  for baselining one that changed the schema. A real diff requires a TTY: `promptNamedWithSchemasConflict`
  throws before reading stdin, and this was confirmed not to be limited to the create-and-delete case — a
  deletion-only diff prompts too.

The remaining routes were squashing history (destroying the reviewed `0001` and `0002`) or hand-writing
snapshot JSON with its opaque `id`/`prevId` chain. Both were rejected: one rewrites reviewed history, the
other fabricates metadata whose correctness nobody could check.

**Decision** — Retire Drizzle Kit's snapshot-based migration system. Delete `meta/`. Ordered, immutable
`.sql` files are the executable migration authority, applied by one small in-repository runner
(`lib/db/migrator.ts`) with a hash-verified ledger.

**Consequences** —

*Lost, deliberately:* automatic snapshot-based diff generation. Nothing detects drift between `schema.ts`
and the migrations by comparison; every schema change now requires a hand-written forward migration.

*Gained:* migrations that say exactly what they do, with no second representation to fall out of sync.
Replacing the lost capability:

- **Immutable SQL migrations** — committed files never change; corrections are new forward migrations.
- **Ledger hash verification** — every applied migration's SHA-256 is recorded, and the runner refuses to
  proceed if a committed migration's content has changed.
- **Clean-database migration tests** — the suite provisions from empty through `0000` → `0001` → `0002`
  and asserts the resulting schema, including every `updated_at` trigger.
- **Schema invariant tests** — constraints, cascades and partial indexes are asserted directly.
- **One provisioning path** — the test harness runs the *same* migrator production uses, so tests can no
  longer verify a schema nobody deploys.

*Also made easier:* `drizzle-kit` left the dependency tree, which removed the only consumer of the
deprecated `@esbuild-kit/*` chain and let the `esbuild` override be dropped.

*Made harder:* a developer who changes `schema.ts` and forgets the migration gets no warning from the
tooling. The schema tests catch it only where they assert the affected structure.

**Alternatives** —

- *`drizzle-kit generate --custom`* — tested; carries the previous snapshot forward unchanged, so it cannot
  represent a schema-changing hand-written migration.
- *Run `generate` once at a real terminal* — viable for a human, and rejected because it leaves the project
  permanently dependent on a manual TTY step that CI cannot perform, to maintain metadata nothing else
  reads.
- *Squash to a fresh baseline* — rejected: destroys the reviewed `0001` and `0002`.
- *Hand-write the snapshot JSON* — rejected: fabricates opaque metadata whose correctness cannot be
  verified by review.
- *Keep the stale metadata with a warning comment* — rejected: a command that silently skips two
  migrations is more dangerous than no command, and a warning is not a control.

**Reconsideration trigger** — Reconsider only after a future pinned Drizzle toolchain demonstrates a
documented, verifiable ability to import or accurately baseline reviewed hand-written migrations without
rewriting migration history or producing misleading metadata.
