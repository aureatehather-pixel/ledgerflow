# Setup, security assumptions, and how to verify them

> **Scope.** The access layer: authentication, per-client authorization, guarded upload, private object
> storage and the append-only audit trail. The extraction engine's gates are described in
> `docs/EXTRACTION.md`. No real client document is used anywhere in this repository.
>
> **Some closures below cite evidence this repository cannot hold:** provider dashboards and live runs
> against provisioned infrastructure. Those operator records are not published. Each such claim keeps its
> date so it can be re-checked rather than believed.

---

## 1. Running it from nothing

**Prerequisites.** Node with `--experimental-strip-types` support (the migration runner uses it; see
`package.json` → `db:migrate`) and npm. Nothing else — no Docker, no local PostgreSQL, no cloud account.
That is deliberate: the development machine had neither Docker nor `psql`, which is why tests run on
PGlite, real PostgreSQL compiled to WASM and provisioned by the same migrations production applies.
Node `>=22.13` is required (`package.json` → `engines`).

```sh
npm ci
cp .env.example .env.local     # then fill it in — see §2
npm run check                  # typecheck + lint + tests. Needs no external service.
```

`npm run check` is the gate. It runs entirely offline against in-process PostgreSQL (PGlite) and an
in-memory object store, so a clean checkout can prove the authorization model on a laptop with no
credentials at all.

**The synthetic demonstration** walks one synthetic firm, client and bank statement through the real
code paths, each step with its rejection case. It has the same offline guarantees as `npm run check`
and does not need `.env.local`:

```sh
npm run demo
```

**The production build** needs no credentials either, but it does need Next.js's native compiler for
the machine it runs on:

```sh
npm run build    # runs scripts/check-native-compiler.ts first, via "prebuild"
```

Install with `npm ci` **on the machine that builds**. The compiler is a platform-specific optional
dependency (`@next/swc-<os>-<cpu>`). If it is missing, because optional dependencies were omitted or
`node_modules` was copied from another OS or CPU, `next build` either downloads one at build time or
falls back to a WASM compiler that Turbopack cannot use. With no network it was observed to exit 0
having built nothing. Two things prevent that here. The committed `.npmrc` sets `include=optional`,
which npm ranks above any `omit`. The `prebuild` preflight refuses to start when the compiler for this
OS/CPU is absent, and names the fix: delete `node_modules` and run `npm ci` again. CI runs the check,
the demo and the build from a clean checkout on Linux, macOS (arm64) and Windows
(`.github/workflows/ci.yml`).

**To run the app rather than the tests**, you additionally need `AUTH_SECRET` and `DATABASE_URL` set,
and the migrations applied:

```sh
# Applies pending migrations to the database named in .env.local. The env file is
# named explicitly — `npm run db:migrate` on its own does NOT load it.
node --env-file=.env.local --experimental-strip-types scripts/migrate.ts

npm run dev
```

**`npm run db:migrate` is valid only when `DATABASE_URL` is already present in the process environment** —
in CI, for example. Nothing in this project loads `.env.local` for it, and nothing should: an implicit
default target is exactly how the wrong database gets migrated (`scripts/migrate.ts:19-21`). Naming the env
file on every invocation is the safety property, not an inconvenience. To migrate a different database,
name a different file.

**The trap worth naming:** `npm run check` passes green with `AUTH_SECRET` empty, because the tests
construct auth explicitly rather than reading the environment. An empty secret surfaces at the first
sign-in attempt in `npm run dev`, not before. Generate one with `openssl rand -base64 32`.

## 2. Configuration

None of these are needed for `npm run check`, `npm run demo` or `npm run build`. They are needed to run
the app against real infrastructure. `.env.example` lists them with no values.

| Variable | Secret? | Purpose and minimum scope |
|---|:---:|---|
| `DATABASE_URL` | **yes** | PostgreSQL (Neon) connection. Read/write on the application database only, not an account API key. |
| `AUTH_SECRET` | **yes** | Better Auth signing secret. 32+ random bytes: `openssl rand -base64 32`. |
| `AUTH_URL` | no | Better Auth base URL, e.g. `http://localhost:3000`. |
| `R2_ACCOUNT_ID` | no | Cloudflare account identifier. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **yes** | An R2 API token scoped to **one bucket**, object read/write. Not an account-wide token. |
| `R2_BUCKET` | no | Bucket name. Public access must be disabled. |
| `MAX_UPLOAD_BYTES` | no | Upload cap. Defaults to 15 MiB when unset. A value that is not a positive integer refuses to start rather than defaulting. |

**CORS:** none required. Uploads pass through the server and the browser never talks to R2 directly.

Two properties of the configuration are worth stating as behaviour rather than as a table:

- **Storage selection fails closed.** `selectObjectStore()` throws when any R2 variable is missing, and
  names only the *variable names*, never values. There is no in-memory fallback outside tests: a
  production process quietly holding a firm's documents in memory would look healthy until its first
  restart. A test asserts this cannot regress (`lib/storage/select.test.ts`).
- **Local development uses real R2**, against an isolated prefix — not a local fake. A fake that exists
  only locally is a difference that hides bugs until deploy.

`.env.local` is git-ignored and must stay that way; `.env.example` is the only tracked env file and
carries no real value.

**One Windows trap worth naming, because the symptom points away from the cause.** Node's `--env-file`
treats a UTF-8 byte-order mark as part of the first key's name, so a BOM'd env file silently loses **its
first line only** — every later assignment parses normally. PowerShell's `Set-Content -Encoding utf8`
writes a BOM, so an env file generated that way yields `DATABASE_URL is not set` from a file that visibly
contains `DATABASE_URL`. Copying `.env.example` is **not** affected: it begins with a comment, so the BOM
lands on a line nothing reads. If you generate an env file rather than copying one, write it without a
BOM. Verified 2026-07-31.

## 3. Where the data physically sits

Region is a PDPA question before it is a latency question. Where a Malaysian firm's client documents may
be processed and stored is an open cross-border question, and it must be answered before any real
document is stored. Nothing real is stored today.

| Component | Intent | Actual, as provisioned |
|---|---|---|
| PostgreSQL (Neon) | Singapore, if offered at project creation | Recorded in an operator record outside this repository. An intended region is not evidence. |
| Object storage (Cloudflare R2) | Jurisdiction to be chosen deliberately, not defaulted | Recorded in an operator record outside this repository. |
| Tests | Nowhere — in-process PGlite and an in-memory store | No network, no credentials, no residency question |

Record the granted values in the operator record when each resource is created, not in this repository.

## 4. Security assumptions

Everything below is a property the system relies on. Some are enforced by code and proven by a test —
those name the test. Some are true only because of something *outside* the code, and those are the
dangerous ones, so they are listed in their own section and not softened.

### 4.1 Enforced in code, with a test

**Identity and session**

- Passwords are Argon2id at the OWASP floor — 19 MiB memory, 2 iterations, parallelism 1 — with
  parameters encoded in the hash, so raising them later re-hashes new passwords without invalidating
  old ones (`lib/auth/password.ts`).
- A malformed or truncated stored hash reads as *wrong password*, never as an error. A distinguishable
  failure is an oracle.
- **There is no public sign-up.** The endpoint is disabled, not merely unlinked (`disableSignUp: true`).
  Users are provisioned through a controlled server-side path.
- Sessions are **database-backed and cookie caching is off**. This is a security invariant, not a
  performance setting: with cookie caching on, a revoked session keeps working until the cookie's cache
  window lapses, which would defeat the entire reason for database sessions. Asserted by a test
  (`lib/auth/policy.ts` → `COOKIE_CACHE_ENABLED`).
- **Two independent expiry limits, enforced by different mechanisms.** A 30-minute *sliding inactivity*
  window is Better Auth's own expiry with `updateAge: 0`, so every authenticated request pushes it
  forward. An **8-hour absolute cap** is not a Better Auth feature at all — Better Auth's refresh is
  rolling and on its own would let a continuously-used session live forever — so the cap is enforced in
  `lib/auth/session.ts` against `sessions.created_at`, which never moves. Rolling expiry is not an
  absolute timeout; do not describe it as one.
- The 30-minute window is **uniform across roles**, rather than the shorter idle window commonly applied
  to administrative sessions. LedgerFlow has no elevated-session mode: `firm_role` decides who may grant
  client assignments but does not create a session with its own risk profile. Revisit when an elevated
  operation (bulk export, firm-wide configuration) exists. The 8-hour cap is relaxed nowhere.
- A deactivated or soft-deleted user **cannot have a session minted** (a `databaseHooks` `create.before`
  hook returning `false`) **and cannot use one already minted** (re-checked on every request in
  `lib/auth/session.ts`). Two gates, because either alone leaves a window.
- `lib/auth` is the *only* place session state is interpreted. A test asserts nothing outside that
  directory touches sessions.

**Authorization**

- **Firm membership authorizes nothing.** Every document read requires a live `client_assignments` row,
  including for partners. This was corrected before implementation; the original design let any firm
  member read any client's file, which is exactly the failure an accounting firm cannot have.
- Ownership is resolved **server-side from the document ID**. No browser-supplied firm or client
  identifier is trusted anywhere.
- Authorization conditions live **in the `WHERE` clause**, not in memory after the fetch. A document the
  actor may not see is never loaded, so there is no in-memory value for a later bug to mishandle
  (`lib/authz/documents.ts`).
- The tenant constraint is applied **even where the assignment join already implies it** — two
  independent reasons to deny beat one, and it is the cheapest defence against a future refactor
  loosening the join.
- **Denials are non-disclosing and undifferentiated.** "Wrong firm", "not assigned", "malformed id" and
  "does not exist" all return the same `NOT_FOUND` with no reason attached. A caller cannot learn
  whether a document exists. A malformed identifier is guarded by `isUuid` (`lib/db/ids.ts`) for this
  reason specifically: without it a malformed id *raised* where a forbidden one returned false, which is
  a measurable difference and therefore an enumeration oracle. That was a real defect found in commit 4
  code and fixed in commit 6.
- Only documents in `status = 'ready'` are visible. A `pending` row may have no bytes behind it and a
  `failed` one certainly does not.

**Upload**

- The declared MIME type is a **claim**; the file signature is **evidence**. Both must agree. A caller
  who can make them disagree can store content the system believes is something else
  (`lib/upload/validation.ts`).
- Storage keys are built **only from server-generated UUIDs** —
  `firms/{uuid}/clients/{uuid}/documents/{uuid}`. The uploaded filename is metadata in a column and
  never reaches a path. Filename cleaning is display hygiene, not the security control.
- Size is capped at the bytes boundary, the earliest point the bytes are in hand. The transport layer
  should cap the request body too, but this is the reliable boundary.
- Authorization is **re-checked inside the finalizing statement**, not only before the upload starts.

**Audit**

- `audit_events` is **append-only, enforced at the database** by a trigger (migration `0004`), not by
  application discipline.
- `lib/audit` is the only module that writes it, and the only place the per-action `detail` allowlist
  lives — so a field cannot leak into the trail from a caller.
- `audit_events.actor_user_id` is **`ON DELETE RESTRICT`**, deliberately, not `SET NULL`. PostgreSQL
  implements `SET NULL` as an `UPDATE`, which the append-only trigger rejects, so deleting a user failed
  outright. Resolved in favour of append-only. See `docs/AUTH-SCHEMA-RECONCILIATION.md`.
- The audit write is attempted on the allowed **and** the denied path alike, so an audit outage
  (`UNAVAILABLE`) looks identical whether or not the document exists and whether or not the caller could
  have read it. An audit outage means the operation *did not happen*.
- **What is deliberately not audited, and why:** unauthenticated failures (no actor to record, and an
  unauthenticated flood would become a write amplifier), upload validation rejections (not an access
  decision), and the client *directory* listing (no client records, once per render). Full reasoning:
  `docs/decisions/0002-audit-authenticated-denials-only.md`.

**Repository**

- `.gitignore` **denies accounting-document types by default with no exception directory** — no
  `!samples/` hole, because an exception directory is exactly where a real statement eventually gets
  dropped "just to test something", and a real document in git history is a PDPA incident that deleting
  the file does not undo. Synthetic fixtures are *generated at test time*, never committed as binaries.
- Committed migrations are **immutable**: the runner records each file's SHA-256 and refuses to migrate
  if one changes. Corrections are new forward migrations.

### 4.2 Assumed, not enforced here — the gaps

These are the ones to read twice. Each was a real hole, stated as one. **Entries that have since been
closed stay in this list and say so**, with the date and the evidence, rather than disappearing — a
closure is most useful where the gap was originally stated. Anything not marked closed is still open.

- **There is no rate limiting.** Deferred from M1 because it needs a shared store to be meaningful
  across instances. · *This deferral expires when the app is first reachable by anything other than
  localhost, or at M5 deploy, whichever comes first.* An unauthenticated endpoint on the public internet
  with no rate limit is not a deferral.
- **There is no malware or content scanning on upload.** Signature checking proves a file *is* the type
  it claims; it proves nothing about whether the file is hostile. `lib/upload/` performs validation,
  MIME-type and signature checks, size limits, orchestration and compensation — and nothing else.
  **This section is the recorded location of that gap**; `CLAUDE.md` § Layout points here rather than
  describing scanning as part of the current architecture.
- **Encryption at rest — closed 2026-07-30, no longer a gap.** Both providers encrypt unconditionally
  (Neon AES-256; Cloudflare R2 AES-256-GCM). The source is **authoritative vendor documentation, not an
  observed dashboard setting**, because neither provider exposes an encryption toggle. **A11 is met.**
  Quotes, source URLs and retrieval dates are in an operator record outside this repository. Kept in
  this list rather than deleted, so the closure is visible where the gap was stated.
- **Transport security is the host's job.** The application assumes it is served over HTTPS and does not
  enforce it. R2 is reached over HTTPS by construction (`lib/storage/r2.ts`). Cookie `Secure`/`SameSite`
  behaviour is Better Auth's default and has not been independently asserted by a test in this project.
- **The migration advisory lock — closed 2026-07-30, no longer a gap.** The limitation of the *test suite*
  is unchanged and still real: PGlite is a single in-process session, so the suite proves the ledger
  primary-key backstop and *nothing* about the lock. What changed is that the mandatory two-connection
  check has now been **run and PASSED**, on a direct endpoint with a holder/waiter observation in
  `pg_locks` rather than timing inference. The run is recorded outside this repository.
- **Timing equalisation on login is proportionate, not resistant.** `spendDummyVerification` narrows the
  gap between "no such user" and "wrong password"; database lookup time, scheduling and network jitter
  still differ, and no unit test can demonstrate otherwise.
- **The bucket's public-access setting — closed 2026-07-31, no longer a gap.** Observed **disabled** in the
  Cloudflare dashboard and recorded in an operator record outside this repository. The assumption it replaced — created
  private, believed private — turned out to be correct, but it was an assumption right up until someone
  looked, and no test in this repository can see it. Re-check on any new bucket.
- **The only bucket provisioned so far is for development.** No production bucket, no production-scoped token, and no
  jurisdiction decision exists yet.
- **This public repository is a curated snapshot, not the development history.** Planning documents,
  design-partner material and infrastructure records were left out on purpose. The boundary is held
  mechanically where it can be: `.gitignore` denies document file types with no exception directory
  (`test/gitignore.test.ts`), and `test/layout.test.ts` fails if any file cites a document that is not
  in the repository.

## 5. Verification procedure

`CLAUDE.md` § Verification requires ground truth over notes and a negative control for every gate.
Running the commands below is how you get that; reading §4 above is not.

### 5.1 The offline gate — run this before calling anything done

```sh
npm run check      # typecheck (app + scripts) + eslint --max-warnings 0 + vitest
```

Tests run **sequentially on purpose** — see the comment in `vitest.config.ts`. No network, no
credentials, no database daemon. No test count is written here; a number written in two places goes
stale in one of them.

**The suite is not perfectly deterministic under load — re-run once before concluding a regression.**
Observed 2026-07-30: one full-suite run reported a single failure while four other full runs and three
targeted runs of the same files were green. The failing run was ~35% slower than the others (340s against
198–257s), which points at the PGlite memory pressure `vitest.config.ts` already documents as the reason
file parallelism is disabled. **The failing test's name was not captured, so this is an honest
unknown rather than a diagnosed flake** — if you see a lone red test, capture it before re-running:

```sh
npx vitest run --reporter=json --outputFile=run.json   # then read testResults[].assertionResults
```

A single unreproducible failure is not licence to ignore a red suite. A *repeatable* one is a real defect,
and a flake that hides one is worse than either.

### 5.2 Proving the gates *reject*

A gate tested only on the passing case is indistinguishable from `return true`. The M1 denial matrix
maps to the M1 acceptance criteria A2–A5 and is automated, not manual:

| What must be denied | Where it is proven |
|---|---|
| A user assigned to client 1 reading client 2's document — **same firm** | `lib/authz/authz.test.ts` |
| A user from firm B reading a firm A document, **holding a valid document id** | `lib/authz/authz.test.ts` |
| An unauthenticated request receiving document bytes | `lib/authz/authz.test.ts`, `app/actions/documents.ts` step 2 |
| A valid session with a tampered, malformed or nonexistent document id | `lib/authz/authz.test.ts` |
| Revoked assignments, deactivated and soft-deleted users | `lib/authz/authz.test.ts`, `lib/auth/auth.test.ts` |
| Uploads whose signature contradicts the declared type, are empty, or exceed the cap | `lib/upload/upload.test.ts` |
| `UPDATE` against `audit_events` | `lib/db/schema.test.ts` |
| Storage selection with a missing variable (must throw, must not fall back to memory) | `lib/storage/select.test.ts` |
| Migrating after a committed migration file's bytes change | `lib/db/migrator.test.ts` |

Two negative controls are load-bearing and must not be quietly deleted:

- `lib/authz/authz.test.ts` asserts the authorization **primitives** write **zero** audit events. That
  is the proof they stay side-effect-free; audit belongs one layer up, in `lib/authz/operations.ts`.
  Upload's equivalent zero-assertions were **converted to positive assertions** when audit landed, which
  is the only correct way to retire a negative control — see
  `docs/decisions/0002-audit-authenticated-denials-only.md`.
- The append-only trigger is proven by a rejected `UPDATE`, not by an accepted `INSERT`.

### 5.3 The live checks — opt-in, and they cost money

```sh
npm run storage:smoke      # LIVE against real R2. Excluded from npm test. Never in CI.
```

Synthetic PDFs only, isolated prefix, cleans up in `afterAll` so an aborted run cannot leave paid
storage behind. It must demonstrate, against the real service: credentials authenticate; a synthetic PDF
lands at the exact server-generated key; stored byte length equals input; deletion works and repeated
deletion is idempotent; a denied token normalises to the storage error boundary **without the key id or
secret appearing in the error**; a forced finalisation failure triggers a real delete; and a forced
delete failure leaves a `failed`, invisible row carrying the recoverable key. It passed on 2026-07-29,
and the evidence table is in an operator record outside this repository.

### 5.4 Checks the test suite cannot make

**None outstanding.** The three checks that were listed here have all been discharged; each is recorded
below with the evidence it produced, because a discharged check is still the thing a future reader needs
when deciding whether it must be re-run.

**Discharged 2026-07-31:** the `claimRun` race, which closed B13. It needed two real database sessions,
and the tests prove the unique-index backstop and not the race above it. *That remains true of the
tests*: do not read green tests as covering it. The property is held by a run recorded outside this
repository.

**Discharged 2026-07-30, both formerly listed here:** two-connection migration concurrency, and
encryption at rest for both providers (which closed A11). Both are likewise recorded outside this
repository.

### 5.5 Secrets

```sh
# Confirm variables are SET without revealing them.
node -e "for (const k of ['DATABASE_URL','AUTH_SECRET','R2_SECRET_ACCESS_KEY']) console.log(k, process.env[k] ? 'set ('+process.env[k].length+' chars)' : 'MISSING')"
```

Never `echo $DATABASE_URL` — it lands in shell history and in CI logs. Acceptance criterion A10 was
verified by scanning every tracked file against the **real credential values**, not against a pattern;
`git check-ignore` confirms `.env.local` is ignored and `.env.example` is the only tracked env file.

### 5.6 What none of this proves

The offline suite proves the authorization model, the schema contract, and the upload state machine. It
proves nothing about extraction accuracy, nothing about whether an export file imports into Sage UBS or
SQL Account, and nothing about behaviour under concurrent load. Those are M0, M2 and M3 gates and they
are measured against the firm's real documents and real systems, not against this repository.
