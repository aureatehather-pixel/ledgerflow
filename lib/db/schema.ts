import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { uuidv7 } from "./ids";

/**
 * M1 schema: tenancy, explicit client access, documents, audit.
 *
 * The load-bearing decision here is that firm membership grants NOTHING.
 * A user reaches a client's documents only through a live `client_assignments`
 * row. In an accounting firm, confidentiality is per-engagement rather than
 * per-firm -- a junior on the Acme engagement has no business reading Beta's
 * bank statements, and a schema where firm membership implies access cannot
 * express that no matter how careful the query layer is.
 *
 * Extraction, reconciliation and provider-call accounting were added for M2a
 * (migration 0005) at the end of this file. Export, posting and destination
 * concepts remain absent and belong to M3.
 */

// --- timestamps ------------------------------------------------------------

/** Every table carries these (data.md). `updated_at` is maintained by a database
 *  trigger, defined in the migration -- application code forgets. */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

const primaryId = uuid("id").primaryKey().$defaultFn(uuidv7);

// --- enums -----------------------------------------------------------------

/** Firm-level role. Governs administration, NOT client data access -- that is
 *  `client_assignments` and only `client_assignments`. */
export const firmRole = pgEnum("firm_role", ["partner", "manager", "staff"]);

/** Per-client access level. `read` may view and download; `write` may also
 *  upload. Deliberately coarse: M1 has two operations. */
export const accessLevel = pgEnum("access_level", ["read", "write"]);

/** Audit outcome. Denials are recorded too (acceptance criterion A8), so the
 *  log answers "who tried and was refused", not only "who succeeded". */
export const auditOutcome = pgEnum("audit_outcome", ["allowed", "denied"]);

/**
 * Upload lifecycle. Postgres and object storage share no transaction, so this
 * names the window where a row exists and its bytes may not.
 *
 *   pending -> NO terminal result was reached. The operation is still running,
 *              or the process died, or the database became unreachable before
 *              the outcome could be recorded.
 *   ready   -> bytes are in storage; the document is visible (terminal)
 *   failed  -> a KNOWN failure; a record, not a document (terminal)
 *
 * `pending` must never also mean "known failure awaiting cleanup" -- if it did,
 * nothing could distinguish an interrupted upload from a completed failure, and
 * any future recovery pass would have no safe way to act. Every synchronous
 * failure path records `failed`, INCLUDING when compensating object deletion
 * itself fails; the surviving object stays recoverable via the storage key on
 * the failed row.
 *
 * Legal transitions: pending -> ready, pending -> failed. Both are terminal;
 * nothing moves a document out of them.
 *
 * Only `ready` is ever externally visible.
 *
 * (Migration 0003's header carries an earlier, looser wording. It is committed
 * and therefore immutable -- this is the current definition.)
 */
export const documentStatus = pgEnum("document_status", [
  "pending",
  "ready",
  "failed",
]);

// --- tenancy ---------------------------------------------------------------

export const firms = pgTable("firms", {
  id: primaryId,
  name: text("name").notNull(),
  ...timestamps,
});

export const users = pgTable(
  "users",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      // A firm is not deleted out from under its users; deletion order is the
      // application's problem to handle explicitly (data.md).
      .references(() => firms.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** Better Auth core field. M1 provisions users server-side and does not
     *  verify email, so this stays false; the column exists because Better
     *  Auth's user model declares it. */
    emailVerified: boolean("email_verified").notNull().default(false),
    /** Better Auth core field. Unused in M1. */
    image: text("image"),
    firmRole: firmRole("firm_role").notNull().default("staff"),
    /** Set to revoke access without destroying audit history. A deactivated
     *  user must fail authentication AND authorization, not just login. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("users_firm_id_idx").on(table.firmId),
    // Partial unique: a soft-deleted user must not block re-registration of the
    // same address (data.md, Soft Deletes).
    uniqueIndex("users_email_unique")
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),
    check("users_email_not_blank", sql`length(trim(${table.email})) > 0`),
  ],
);

// --- Better Auth owned tables ----------------------------------------------
//
// These four mirror Better Auth's core models (`user`, `session`, `account`,
// `verification`) mapped onto plural snake_case via its `modelName` / `fields`
// options. Better Auth is the authority on their shape: see
// docs/AUTH-SCHEMA-RECONCILIATION.md for the field-by-field comparison against
// the generated upstream contract and every deliberate deviation.
//
// There is no `user_credentials` table. Better Auth stores the Argon2id hash in
// `accounts.password` on a row whose `provider_id` is "credential". A separate
// credentials table would be dead weight that LOOKS like the place passwords
// live, which is worse than not having one.

/**
 * Database-backed sessions -- the single session authority. No JWT mirrors this
 * state, so revoking a row takes effect on the next request.
 *
 * `token` is the opaque secret in the cookie; `id` is the primary key. They are
 * separate because Better Auth requires both, and because the value that
 * travels in a cookie should not be the value foreign keys are built on.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: primaryId,
    /** Opaque 32-char secret generated by Better Auth. Never logged. */
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Sliding: Better Auth pushes this forward on activity (30-minute idle). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
    // The 8-hour absolute cap is evaluated against created_at, which is never
    // updated -- unlike expires_at, which slides. See lib/auth/session.ts.
    index("sessions_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Better Auth's `account` model. For email/password this holds ONE row per user
 * with `provider_id = 'credential'` and the Argon2id hash in `password`.
 *
 * The token/expiry/scope columns are nullable and unused in M1. They are present
 * because they are part of Better Auth's account model contract and its adapter
 * builds queries from that field list -- omitting them risks runtime failures on
 * the credentials path. Their presence is NOT OAuth support: no provider is
 * configured, and nothing writes them.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: primaryId,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** For credentials this is the user id; for OAuth it would be the remote id. */
    accountId: text("account_id").notNull(),
    /** "credential" for email/password. */
    providerId: text("provider_id").notNull(),
    /** Argon2id encoded hash. The ONLY place a password hash exists. */
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    ...timestamps,
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

/**
 * Better Auth's `verification` model. Required by the model contract even though
 * M1 configures no email verification and no password reset.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: primaryId,
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("verifications_identifier_idx").on(table.identifier),
    index("verifications_expires_at_idx").on(table.expiresAt),
  ],
);

// --- clients and the authorization edge ------------------------------------

export const clients = pgTable(
  "clients",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** The firm's own reference for this client. */
    code: text("code").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("clients_firm_id_idx").on(table.firmId),
    uniqueIndex("clients_firm_code_unique")
      .on(table.firmId, table.code)
      .where(sql`${table.deletedAt} is null`),
    check("clients_code_not_blank", sql`length(trim(${table.code})) > 0`),
  ],
);

/**
 * THE authorization edge. No row here, no access -- full stop.
 *
 * Named for what it is rather than `clients_users`: data.md's alphabetical
 * junction convention describes a pure link table, and this one carries its own
 * attributes and lifecycle (who granted it, at what level, when it was revoked).
 * That makes it an entity that happens to join two others.
 *
 * `revokedAt` rather than deletion, so "who could see this client last March"
 * remains answerable -- which is the question an auditor actually asks.
 */
export const clientAssignments = pgTable(
  "client_assignments",
  {
    id: primaryId,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    accessLevel: accessLevel("access_level").notNull().default("read"),
    /** Nullable: a seed or system grant has no granting user. */
    assignedBy: uuid("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("client_assignments_user_id_idx").on(table.userId),
    index("client_assignments_client_id_idx").on(table.clientId),
    index("client_assignments_assigned_by_idx").on(table.assignedBy),
    // The hot path: "is this user assigned to this client, right now?"
    // Partial, because revoked rows are never a hit (data.md, Indexing).
    index("client_assignments_live_idx")
      .on(table.userId, table.clientId)
      .where(sql`${table.revokedAt} is null`),
    // At most one live assignment per user/client, so the boundary can never
    // face two rows disagreeing about access level.
    uniqueIndex("client_assignments_live_unique")
      .on(table.userId, table.clientId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

// --- documents -------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    id: primaryId,
    /**
     * Denormalized from `clients.firm_id`.
     *
     * Canonical source: `clients.firm_id`. It is duplicated so the request
     * boundary can assert firm ownership without a join -- a bug in the client
     * lookup then cannot silently widen access across firms. Staleness is
     * structurally impossible rather than reconciled: a document never changes
     * client, and a client never changes firm. If either becomes true, this
     * column needs a reconciliation mechanism (data.md) or must be dropped.
     */
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    /** Object-storage key. Never a public URL -- the bucket is private and
     *  bytes are served only through the authorization boundary. */
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    /** Verified from the file signature, not from the browser's claim. */
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /** Content hash: duplicate detection, and evidence a stored object was not
     *  altered after upload. */
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** See `documentStatus`. Defaults to `pending`: a row created outside the
     *  upload path has not been shown to have bytes behind it. */
    status: documentStatus("status").notNull().default("pending"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("documents_firm_id_idx").on(table.firmId),
    index("documents_client_id_idx").on(table.clientId),
    index("documents_uploaded_by_idx").on(table.uploadedBy),
    index("documents_client_created_idx").on(table.clientId, table.createdAt),
    index("documents_client_status_idx").on(table.clientId, table.status),
    // Retry idempotence: one visible copy of a given file per client.
    uniqueIndex("documents_client_sha256_ready_unique")
      .on(table.clientId, table.sha256)
      .where(sql`${table.status} = 'ready' and ${table.deletedAt} is null`),
    check("documents_byte_size_positive", sql`${table.byteSize} > 0`),
    check("documents_sha256_length", sql`length(${table.sha256}) = 64`),
    check(
      "documents_storage_key_not_blank",
      sql`length(trim(${table.storageKey})) > 0`,
    ),
  ],
);

// --- audit -----------------------------------------------------------------

/**
 * Append-only. No `updated_at` semantics are meaningful and nothing may edit a
 * row: an audit trail that can be rewritten is not evidence of anything.
 *
 * `actorUserId` is nullable at the column level so an unauthenticated attempt
 * would be recordable, but nothing writes null today: ADR 0002 records only
 * authenticated actors. `resourceId` is plain uuid rather than a foreign key --
 * the log must survive the deletion of what it describes, which is exactly when
 * it matters most.
 *
 * The actor FK is ON DELETE RESTRICT (migration 0004), not SET NULL. SET NULL
 * would have made deleting a user rewrite audit rows, which is both an UPDATE
 * this table forbids and an erasure of the one field that makes an event
 * evidence. A user who appears in the trail cannot be hard-deleted; the
 * application soft-deletes (`deletedAt`, `deactivatedAt`) and always did.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: primaryId,
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    outcome: auditOutcome("outcome").notNull(),
    /** Structured context. Must never contain secrets, document bytes, or
     *  personal data beyond what the action itself implies. */
    detail: jsonb("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_actor_idx").on(table.actorUserId, table.occurredAt),
    index("audit_events_resource_idx").on(table.resourceId, table.occurredAt),
    index("audit_events_occurred_at_idx").on(table.occurredAt),
    check("audit_events_action_not_blank", sql`length(trim(${table.action})) > 0`),
  ],
);

// --- relations -------------------------------------------------------------

export const firmsRelations = relations(firms, ({ many }) => ({
  users: many(users),
  clients: many(clients),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  firm: one(firms, { fields: [users.firmId], references: [firms.id] }),
  assignments: many(clientAssignments),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  firm: one(firms, { fields: [clients.firmId], references: [firms.id] }),
  assignments: many(clientAssignments),
  documents: many(documents),
}));

export const clientAssignmentsRelations = relations(
  clientAssignments,
  ({ one }) => ({
    user: one(users, {
      fields: [clientAssignments.userId],
      references: [users.id],
    }),
    client: one(clients, {
      fields: [clientAssignments.clientId],
      references: [clients.id],
    }),
  }),
);

export const documentsRelations = relations(documents, ({ one }) => ({
  firm: one(firms, { fields: [documents.firmId], references: [firms.id] }),
  client: one(clients, {
    fields: [documents.clientId],
    references: [clients.id],
  }),
}));

// --- M2: extraction ---------------------------------------------------------

/**
 * Extraction lifecycle.
 *
 *   pending    queued; nothing started
 *   running    claimed by a worker
 *   succeeded  a statement was extracted, validated AND reconciled
 *   exception  extracted and structurally valid, but the arithmetic gate
 *              rejected it. Awaiting a person (non-negotiable 3). NOT a
 *              processing failure: retrying identical bytes reconciles
 *              identically, so it is terminal without human involvement.
 *   failed     processing could not produce a statement at all
 *
 * `exception` describes the *statement's arithmetic*, not a workflow position.
 * It is not a reviewer state, an approval step or an assignment; M3a owns those.
 */
export const extractionRunStatus = pgEnum("extraction_run_status", [
  "pending",
  "running",
  "succeeded",
  "exception",
  "failed",
]);

/** Which input path produced what the parser saw. `unknown` until decided. */
export const extractionInputPath = pgEnum("extraction_input_path", [
  "unknown",
  "text_layer",
  "image_only",
]);

/** How one provider call ended. Mirrors `ModelCallOutcome`. */
export const providerCallOutcome = pgEnum("provider_call_outcome", [
  "rejected_before_invocation",
  "provider_invocation_failed",
  "provider_output_malformed",
  "succeeded",
]);

/**
 * One extraction attempt against one document.
 *
 * `firmId` and `clientId` are denormalized for the same reason `documents`
 * denormalizes them, with the same staleness argument: a run never changes
 * document, a document never changes client, a client never changes firm.
 *
 * Every child table below reaches its tenant through a **composite foreign key
 * that includes `firm_id`**, so a row cannot reference a parent belonging to a
 * different firm even if application code tries. Tenant identity is therefore
 * enforced relationally, not merely carried alongside.
 */
export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    /** 1-based. Commit 6 owns retry policy; this records which try produced what. */
    attempt: integer("attempt").notNull().default(1),
    status: extractionRunStatus("status").notNull().default("pending"),
    inputPath: extractionInputPath("input_path").notNull().default("unknown"),
    /** `StatementParser.id`: a result traces to the code that produced it. */
    parserId: text("parser_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Typed taxonomy. `detail` is bounded and content-free by construction --
     *  see `lib/domain/failures.ts` and its tests. */
    failureKind: text("failure_kind"),
    failureDetail: text("failure_detail"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("extraction_runs_id_firm_unique").on(table.id, table.firmId),
    index("extraction_runs_firm_status_idx").on(table.firmId, table.status),
    index("extraction_runs_client_idx").on(table.clientId),
    uniqueIndex("extraction_runs_document_attempt_unique").on(
      table.firmId,
      table.documentId,
      table.attempt,
    ),
    // The idempotency backstop `lib/extract/orchestration` relies on: at most
    // one successful run per document, enforced by the database rather than by
    // a worker's care.
    uniqueIndex("extraction_runs_one_success_per_document")
      .on(table.firmId, table.documentId)
      .where(sql`${table.status} = 'succeeded'`),
    check("extraction_runs_attempt_positive", sql`${table.attempt} > 0`),
  ],
);

/**
 * The canonical statement, persisted.
 *
 * Mirrors `lib/domain/statement.ts` field for field and adds nothing. Reviewed
 * column by column against the firewall: no GL account, no tax code, no posting
 * or reviewer state, no approval, no destination identifier, no billing.
 * `reconciled` and `deltaSen` are arithmetic about this document, not a position
 * in anyone's workflow.
 *
 * Money is `bigint` in Postgres and `bigint` in JavaScript, never a JSON number:
 * a balance that round-trips through `JSON.parse` has become a float.
 */
export const statements = pgTable(
  "statements",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    /** As printed. Not normalised, not resolved against anything. */
    accountReference: text("account_reference").notNull(),
    currency: text("currency").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    openingBalanceSen: bigint("opening_balance_sen", {
      mode: "bigint",
    }).notNull(),
    closingBalanceSen: bigint("closing_balance_sen", {
      mode: "bigint",
    }).notNull(),
    pageCount: integer("page_count").notNull(),
    /** Computed by `lib/reconcile`, never by a model (non-negotiable 2). */
    reconciled: boolean("reconciled").notNull(),
    computedClosingSen: bigint("computed_closing_sen", {
      mode: "bigint",
    }).notNull(),
    deltaSen: bigint("delta_sen", { mode: "bigint" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("statements_id_firm_unique").on(table.id, table.firmId),
    uniqueIndex("statements_run_unique").on(table.firmId, table.runId),
    index("statements_firm_document_idx").on(table.firmId, table.documentId),
    check("statements_currency_length", sql`length(${table.currency}) = 3`),
    check("statements_page_count_positive", sql`${table.pageCount} > 0`),
    check(
      "statements_period_ordered",
      sql`${table.periodStart} <= ${table.periodEnd}`,
    ),
    // The gate, restated at the database: reconciled means the delta is exactly
    // zero. No tolerance exists here either.
    check(
      "statements_reconciled_iff_zero_delta",
      sql`(${table.reconciled} = true) = (${table.deltaSen} = 0)`,
    ),
  ],
);

/** One printed transaction line. Debit and credit are magnitudes; direction is
 *  positional, exactly as the document prints it. */
export const statementLines = pgTable(
  "statement_lines",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    statementId: uuid("statement_id").notNull(),
    /** 0-based position as extracted, so page order is reconstructable. */
    lineIndex: integer("line_index").notNull(),
    transactionDate: date("transaction_date").notNull(),
    /** The token exactly as printed. Provenance for whoever checks the page. */
    dateRaw: text("date_raw").notNull(),
    description: text("description").notNull(),
    debitSen: bigint("debit_sen", { mode: "bigint" }).notNull(),
    creditSen: bigint("credit_sen", { mode: "bigint" }).notNull(),
    /** Null means the document did not print one. Not zero. */
    runningBalanceSen: bigint("running_balance_sen", { mode: "bigint" }),
    sourcePage: integer("source_page").notNull(),
    sourceLocator: text("source_locator"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("statement_lines_statement_index_unique").on(
      table.firmId,
      table.statementId,
      table.lineIndex,
    ),
    index("statement_lines_statement_idx").on(table.firmId, table.statementId),
    check("statement_lines_debit_non_negative", sql`${table.debitSen} >= 0`),
    check("statement_lines_credit_non_negative", sql`${table.creditSen} >= 0`),
    // The domain invariant, enforced by the database: exactly one side moves.
    check(
      "statement_lines_exactly_one_side",
      sql`(${table.debitSen} = 0) <> (${table.creditSen} = 0)`,
    ),
    check("statement_lines_page_positive", sql`${table.sourcePage} > 0`),
  ],
);

/**
 * Operational metadata for one provider call. **Nothing else.**
 *
 * What is absent is the point of the table: no prompt, no raw response, no
 * extracted transaction text, no document content. A statement is a client's
 * financial record and a cost ledger has no business holding one; a table that
 * *could* is the one that eventually leaks. A test asserts no column here is
 * capable of carrying a payload.
 *
 * `failureDetail` is admitted only because the taxonomy guarantees it names
 * shape rather than content, and tests in `lib/domain` and `lib/extract` prove
 * that for money, dates, PDFs and provider output alike.
 */
export const providerCalls = pgTable(
  "provider_calls",
  {
    id: primaryId,
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** The commercial terms billed under: four columns rather than one string so
     *  a mode is queryable. See `PricingMode`. */
    pricingPlatform: text("pricing_platform").notNull(),
    pricingInference: text("pricing_inference").notNull(),
    pricingRouting: text("pricing_routing").notNull(),
    pricingCacheWriteTtl: text("pricing_cache_write_ttl").notNull(),
    rateTableVersion: text("rate_table_version").notNull(),
    rateEffectiveFrom: date("rate_effective_from"),
    requestId: text("request_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    currency: text("currency").notNull(),
    estimatedMaxCostMicrocents: bigint("estimated_max_cost_microcents", {
      mode: "bigint",
    }),
    actualCostMicrocents: bigint("actual_cost_microcents", { mode: "bigint" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    outcome: providerCallOutcome("outcome").notNull(),
    failureKind: text("failure_kind"),
    failureDetail: text("failure_detail"),
    ...timestamps,
  },
  (table) => [
    index("provider_calls_firm_run_idx").on(table.firmId, table.runId),
    index("provider_calls_firm_started_idx").on(table.firmId, table.startedAt),
    uniqueIndex("provider_calls_request_id_unique")
      .on(table.firmId, table.requestId)
      .where(sql`${table.requestId} is not null`),
    check("provider_calls_currency_length", sql`length(${table.currency}) = 3`),
    check(
      "provider_calls_costs_non_negative",
      sql`coalesce(${table.estimatedMaxCostMicrocents}, 0) >= 0 and coalesce(${table.actualCostMicrocents}, 0) >= 0`,
    ),
    check(
      "provider_calls_ordered",
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);
