# LedgerFlow

**Status: in development.**
LedgerFlow is a document-intake and extraction engine being built for one accounting design partner in Malaysia.
It is not deployed for operational use, it has no bank-statement parser yet, and no extraction accuracy has been measured.
What exists is the foundation that a parser will plug into: the access layer, the data model, and the arithmetic gates.

*"LedgerFlow" is a working name.*

## The problem

Small Malaysian accounting firms spend most of their bookkeeping time typing transactions from source documents into their accounting system.
Bank statements, supplier invoices and receipts arrive as PDFs and phone photos.
Staff read each one and key the lines into Sage UBS or SQL Account.

The goal is to remove the typing, not the judgment.
Documents go in, line items are extracted, the arithmetic is checked in code, an accountant reviews what could not be confirmed, and the output is an import file a named person approves.
**Nothing posts automatically.**

Three properties make this harder than "OCR to CSV":

- **Client documents are confidential.** Every read must be authorized per client, and every decision must leave a trail an auditor can trust.
- **A plausible wrong number is the worst failure.** A float rounding error, or a date read as `MM/DD` instead of `DD/MM`, produces output that looks right and is not.
- **Language models are unreliable at arithmetic.** In this design a model may only ever *read* line items. Every total and every balance is computed in code.

## What exists today

| Area | State |
|---|---|
| Authentication | Implemented. Better Auth, database-backed sessions, Argon2id, no public sign-up, a 30-minute idle window plus an 8-hour absolute cap. |
| Per-client authorization | Implemented. Firm membership grants nothing; every document read needs a live client assignment. |
| Guarded upload into private storage | Implemented. Signature, type and size checks, then reserve → put → finalize with authorization re-checked inside the finalizing statement. |
| Append-only audit trail | Implemented. One writer, an allowlisted detail schema, and `UPDATE` rejected by the database. |
| Exact money and dates | Implemented. Integer sen (`bigint`), and dates that refuse an ambiguous day/month reading. |
| Reconciliation gate | Implemented. Pure and I/O-free, with no tolerance parameter. |
| Cost metering and a per-call ceiling | Implemented. A **monthly** ceiling is not. |
| Extraction engine scaffolding | Implemented: parser port and registry, PDF input paths, run state machine with idempotent retries, persistence. |
| Bank-statement parser | **Not built.** `StatementParser` has no implementation. |
| Model-based extraction | **Not built.** No model is chosen, and no provider SDK is installed. |
| Extraction accuracy | **Not measured.** The accuracy harness exists and has never run against a real document. |
| Classification, review UI, export to UBS / SQL Account | **Not built.** The web app's home page is a placeholder. |

`docs/EXTRACTION.md` §7 is the complete list of what deliberately does not exist yet.

## Architecture

```
upload ──► validate ──► private object storage        (lib/upload, lib/storage)
   │          signature, type, size
   ▼
authorize every read and write per client              (lib/auth, lib/authz)
   │          and record every decision                (lib/audit)
   ▼
extract line items ──► validate ──► RECONCILE ──► review ──► export file
   (lib/extract)       (lib/domain)  (lib/reconcile)   not built   not built
   no parser yet
```

| Module | Responsibility |
|---|---|
| `lib/auth` | The only place session state is interpreted. A test asserts nothing else touches sessions. |
| `lib/authz` | Tenant, role and client-assignment authorization, and the audited operations built on it. |
| `lib/upload` | Validation and the reserve → put → finalize orchestration, including storage/database compensation when finalization fails. |
| `lib/storage` | A two-method object-storage port. Cloudflare R2 specifics never leave this directory. |
| `lib/audit` | The append-only trail and the only writer of `audit_events`. |
| `lib/db` | Schema, ordered SQL migrations (checksummed and immutable once committed), and the migration runner. |
| `lib/domain` | Money as integer sen, unambiguous dates, the failure taxonomy, and the `Statement` model. |
| `lib/reconcile` | `opening + Σ credits − Σ debits = closing`, and nothing else. |
| `lib/cost` | Rate table, pre-call estimation, and a ceiling checked before a call that fails loud. |
| `lib/extract` | `input/` is the only directory that may import a PDF library; `model/` is the only one that may reach a model provider. |
| `lib/observability` | Operational events, separate from the audit trail. No event may carry a client's amount. |
| `lib/accuracy` | The accuracy harness. It reports counts and line positions, never the values that differed. |

Each boundary in that table is held by a structural test rather than by convention.
`CLAUDE.md` § Layout names the test for each one.

### The guarantees, and where they are proven

- **Guarded uploads.**
  A file's declared type is a claim and its leading bytes are evidence; both must agree.
  Validation runs before any database access, the storage key is generated by the server and never includes the caller's filename, and authorization is re-checked inside the statement that makes the document visible.
  Proven in `lib/upload/upload.test.ts` and `lib/upload/validation.test.ts`.
- **Private storage.**
  Objects live under `firms/<firm>/clients/<client>/documents/<id>`.
  Storage selection fails closed: a missing R2 variable stops the process rather than falling back to memory.
  Proven in `lib/storage/select.test.ts`.
- **Client-assignment authorization.**
  A partner sees nothing they are not assigned to.
  A foreign firm's document, a missing document and a malformed identifier all produce the same refusal, so the response cannot be used to enumerate.
  Proven in `lib/authz/authz.test.ts` and `lib/authz/operations.test.ts`.
- **Append-only audit.**
  Every access decision, allowed or denied, is recorded.
  Writes are audited in the same transaction as the change they describe, so an audit failure rolls the change back; a read whose audit row cannot be written withholds the document.
  `UPDATE` on `audit_events` is rejected by a database trigger, not by application code.
  Proven in `lib/audit/audit.test.ts`.
- **Exact reconciliation in integer sen.**
  Amounts are parsed into `bigint` sen and never touch a float.
  A statement off by one sen is an exception for a human, with no threshold below which a mismatch is ignored.
  Only a statement that passed the gate can exist as a `ReconciledStatement`.
  Proven in `lib/reconcile/reconcile.test.ts` and `lib/domain/money.test.ts`.

## Try it

Requirements: Node `>=22.13` and npm.
No database, cloud account, credentials or network access is needed after `npm ci`.

```sh
npm ci
npm run check    # typecheck + lint + the full test suite, offline
npm run demo     # the synthetic walk-through below
npm run build    # production build; needs no credentials
```

Tests run against PGlite, which is real PostgreSQL compiled to WASM, provisioned by the same migrations production applies.
Object storage is an in-memory implementation of the same port.

### The synthetic demo

`npm run demo` runs `test/demo.test.ts`: one synthetic firm, one synthetic client and one synthetic bank statement, walked through the real code paths.
Every step is an assertion, so the demo fails rather than drifts if a guarantee stops holding.

```
✓ 1. client-assignment authorization > refuses a staff member who tries to grant themselves access
✓ 1. client-assignment authorization > lets a partner assign the client to one staff member
✓ 2. guarded upload into private storage > refuses a file whose bytes contradict its declared type, before storing anything
✓ 2. guarded upload into private storage > refuses an upload from a colleague with no assignment to this client
✓ 2. guarded upload into private storage > accepts a synthetic PDF and stores it under a server-generated, tenant-scoped key
✓ 3. reading a document: firm membership grants nothing > lets the assigned staff member read it
✓ 3. reading a document: firm membership grants nothing > refuses an unassigned colleague in the same firm
✓ 3. reading a document: firm membership grants nothing > refuses the partner of another firm, with the same answer as a missing document
✓ 4. the append-only audit trail > recorded every access decision above, allowed and denied
✓ 4. the append-only audit trail > refuses to rewrite history, at the database
✓ 5. exact money and unambiguous dates > holds amounts as integer sen, so 0.10 + 0.20 is exactly 0.30
✓ 5. exact money and unambiguous dates > refuses 03/04/2026 until a day/month convention is stated
✓ 6. reconciliation is a gate: opening + credits - debits = closing > passes a synthetic statement that balances to the sen
✓ 6. reconciliation is a gate: opening + credits - debits = closing > rejects the same statement with one amount misread by 1 sen
```

The statement in steps 5 and 6 is typed in by hand from printed tokens.
The demo does not show extraction, because no parser exists.

### Building on another machine

Run `npm ci` on the machine that builds.
Next.js's native compiler is a platform-specific optional dependency, so a `node_modules` copied from another OS or CPU is missing the right one.
The `prebuild` step (`scripts/check-native-compiler.ts`) detects that and stops with the fix, instead of letting `next build` fall back to a compiler Turbopack cannot use.
`docs/SETUP.md` §1 has the details.

### Running the app against real infrastructure

The app itself needs PostgreSQL (Neon), a Cloudflare R2 bucket and an auth secret.
`docs/SETUP.md` covers configuration, migrations, the security assumptions **including the known gaps**, and how to verify each one.
`npm run storage:smoke` exercises a real bucket; it costs money and never runs in `npm test` or CI.

## Repository guide

| Read | For |
|---|---|
| `CLAUDE.md` | Project law: the non-negotiables, conventions and layout. Written for human contributors and coding agents alike. |
| `docs/SETUP.md` | Setup, configuration, security assumptions and gaps, and the verification procedure. |
| `docs/EXTRACTION.md` | The extraction engine: boundaries, gates, and what it cannot do yet. |
| `docs/decisions/` | Architecture decision records. Dated, and kept as written. |
| `docs/AUTH-SCHEMA-RECONCILIATION.md` | Better Auth's schema contract and each deliberate deviation. |
| `docs/DEPENDENCY-OVERRIDES.md` | Why each `overrides` entry exists and when to delete it. |
| `lib/db/migrations/README.md` | The migration contract. |

### About this public snapshot

This repository is a curated public release of a private working repository.
Business planning, design-partner material and infrastructure records were left out on purpose, and no client document has ever been part of either repository.
`test/layout.test.ts` fails if any file cites a document that is not in this repository.

The ADRs in `docs/decisions/` are kept exactly as written and may cite planning documents that are not published.
Code comments sometimes cite `standards.md`, `data.md`, `api.md` or `auth.md`.
These are the author's personal engineering standards, which are not published; each comment states the rule it applies.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
