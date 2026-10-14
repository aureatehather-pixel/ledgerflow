# Better Auth Schema Reconciliation

> **Upstream contract** — `better-auth@1.6.25`, exactly as pinned. The model definitions below were read
> from the installed package at runtime (`auth.$context.tables`), not from documentation.
> **Verified** — 2026-07-29. Re-run the comparison whenever `better-auth` is upgraded.
> **Rule** — Better Auth owns the shape of `sessions`, `accounts` and `verifications`, and of the core
> fields it declares on `users`. LedgerFlow owns everything else. Generated output is a **contract to
> satisfy, not authority to overwrite domain columns.**

## How to regenerate the contract

```js
// run from the project root
import { betterAuth } from "better-auth";
const auth = betterAuth({ secret: "x".repeat(32), baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true, disableSignUp: true } });
const ctx = await auth.$context;
console.log(JSON.stringify(ctx.tables, null, 2));
```

---

## Mapping strategy

Better Auth's models are singular (`user`, `session`, `account`, `verification`) with camelCase fields.
LedgerFlow uses plural snake_case tables. Both are satisfied without a per-field mapping:

- **`usePlural: true`** on the Drizzle adapter maps `user`→`users`, `session`→`sessions`,
  `account`→`accounts`, `verification`→`verifications`.
- **Field names need no mapping.** Better Auth addresses fields by their camelCase names, which are exactly
  our Drizzle property names; Drizzle translates those to snake_case columns underneath.
- **`advanced.database.generateId`** returns our `uuidv7()`, so Better Auth's ids are valid `uuid` values.
  Without this it emits 32-character strings that a `uuid` column rejects.

---

## `user` → `users`

| BA field | Type | Null | Constraint | LF column | Exists after 0002 | Owner |
|---|---|---|---|---|---|---|
| `id` | uuid | NOT NULL | PK | `id` | ✅ | LF |
| `name` | text | NOT NULL | — | `name` | ✅ | LF |
| `email` | text | NOT NULL | UNIQUE | `email` | ✅ | shared |
| `emailVerified` | boolean | NOT NULL, default | — | `email_verified` | ✅ added by 0002 | BA |
| `image` | text | NULL | — | `image` | ✅ added by 0002 | BA |
| `createdAt` | timestamptz | NOT NULL, default | — | `created_at` | ✅ | LF |
| `updatedAt` | timestamptz | NOT NULL | — | `updated_at` | ✅ | LF |
| — | — | — | — | `firm_id`, `firm_role`, `deactivated_at`, `deleted_at` | ✅ | **LF domain** |

## `session` → `sessions`

Every field present. `token` uniquely indexed; `user_id` FK to `users` `ON DELETE CASCADE`; `created_at`
additionally indexed because the absolute cap reads it.

## `account` → `accounts`

All 12 fields present. `password` holds the Argon2id hash for `provider_id = 'credential'`.
`(provider_id, account_id)` uniquely indexed; `user_id` FK `ON DELETE CASCADE`.

## `verification` → `verifications`

All fields present. Unused in M1 — no email verification and no password reset are configured — but the
model is part of the adapter contract.

---

## Intentional deviations from the generated contract

Every one of these is a deliberate LedgerFlow choice, not an oversight.

### 1. `users.email` is uniquely indexed **partially**, not absolutely

Upstream declares `email` UNIQUE. We enforce `UNIQUE (email) WHERE deleted_at IS NULL`.

**Why:** soft deletion. An absolute unique index would let a deleted user permanently block an address
(`data.md`, Soft Deletes).

**The risk this creates, and how it is closed:** Better Auth knows nothing about `deleted_at`, so it would
resolve a login against a soft-deleted row. Closed at three points — `softDeleteUser` **tombstones the
address** to `deleted+<id>@invalid.local` so it can never be matched again; the credential row is deleted
with it; and `getAuthenticatedActor` independently refuses any user with `deleted_at` or `deactivated_at`
set. Covered by *"tombstones the email and resolves reuse to the active account only"*.

### 2. Extra domain columns on `users`

`firm_id`, `firm_role`, `deactivated_at`, `deleted_at` are LedgerFlow's. Better Auth neither reads nor
writes them; the adapter selects only fields it declares. They are **not** registered as
`user.additionalFields` — the canonical helper reads them from the database directly, which keeps domain
state out of Better Auth's serialization path and guarantees the helper sees current values rather than
whatever a session payload carried.

### 3. `sessions.created_at` carries an index upstream does not require

The 8-hour absolute cap filters on it. Upstream has no absolute cap, so it has no reason to index it.

### 4. `updated_at` is maintained by a database trigger

Upstream expects the adapter to set it. We keep the trigger from migration `0001` on all three Better Auth
tables as well, because a trigger cannot be bypassed by a migration, a psql session, or a future code path.
Better Auth also writing the column is harmless — the trigger simply wins.

### 5. Nullable OAuth columns are present and unused

`access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`
exist because they are part of Better Auth's `account` model and its adapter builds queries from that field
list. **This is not OAuth support:** no provider is configured, nothing writes them, and no token
encryption exists because no tokens exist.

### 6. No `user_credentials` table

Removed by `0002`. Better Auth stores the hash in `accounts.password`; a second credential table would be
empty and would *look* like the place passwords live. Asserted absent by test.

---

## Cascade behaviour — verified deliberately

| Relationship | On delete | Consequence |
|---|---|---|
| `sessions.user_id` → `users.id` | CASCADE | Deleting a user removes their sessions. |
| `accounts.user_id` → `users.id` | CASCADE | Deleting a user removes their credentials. |
| `client_assignments.user_id` → `users.id` | CASCADE | LedgerFlow's own choice: a removed user holds no assignments. |
| `documents.uploaded_by` → `users.id` | **RESTRICT** | A user who has uploaded anything **cannot be deleted at all.** |
| `audit_events.actor_user_id` → `users.id` | **RESTRICT** | A user named in the audit trail **cannot be deleted at all.** Changed from SET NULL by migration `0004` — see below. |

**No cascade path runs from authentication into `clients`, `documents`, or `audit_events`.** In practice
`documents.uploaded_by` RESTRICT blocks hard user deletion outright, which is the safe direction — and M1
implements soft deletion only.

**Why `audit_events.actor_user_id` stopped being SET NULL (migration `0004`, 2026-07-29).** SET NULL was
described here as "history survives the actor". It collided with the other property the schema had claimed
since `0000` — that `audit_events` is append-only — because Postgres implements SET NULL as
`UPDATE ONLY audit_events SET actor_user_id = NULL`, which the append-only trigger rejects. Deleting a user
failed outright, caught by `schema.test.ts`.

Resolved in favour of append-only. Nulling the actor does not preserve history, it removes the one field
that makes an event evidence. RESTRICT is also what `documents.uploaded_by` already does, so this makes the
two consistent rather than introducing a new rule: hard user deletion was already blocked for anyone who had
uploaded a document. The application soft-deletes and always did. Reasoning and reversal path:
[`decisions/0002-audit-authenticated-denials-only.md`](decisions/0002-audit-authenticated-denials-only.md).
