-- Replace the Auth.js-shaped authentication tables with Better Auth's model.
--
-- WHY DROP RATHER THAN ALTER
-- `sessions` was keyed on `session_token`; Better Auth requires a separate `id`
-- primary key plus a uniquely-indexed `token`. `accounts` used Auth.js's
-- provider/provider_account_id/type triple; Better Auth uses
-- provider_id/account_id and -- critically -- stores the password hash in
-- `accounts.password`. Neither change is expressible additively.
--
-- `user_credentials` is dropped outright: Better Auth never reads it, so keeping
-- it would leave an empty table that LOOKS like where passwords live.
--
-- SAFETY AT TIME OF WRITING (2026-07-29): all three tables are empty and have
-- never been applied to any shared environment -- only to ephemeral in-process
-- PGlite instances in tests. This migration is destructive and must not be
-- re-run against a database that has authentication data.
--
-- Domain tables (firms, clients, client_assignments, documents, audit_events)
-- are deliberately untouched.

-- 1. Better Auth core columns on the existing users table (additive).
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint

-- 2. Remove the superseded Auth.js tables.
DROP TRIGGER IF EXISTS user_credentials_set_updated_at ON "user_credentials";--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_set_updated_at ON "sessions";--> statement-breakpoint
DROP TRIGGER IF EXISTS accounts_set_updated_at ON "accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "user_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "sessions";--> statement-breakpoint
DROP TABLE IF EXISTS "accounts";--> statement-breakpoint

-- 3. Better Auth session model.
--    expires_at slides forward on activity (30-minute idle window).
--    created_at never moves, and is what the 8-hour absolute cap is measured
--    against -- see lib/auth/session.ts.
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id")
		REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at");--> statement-breakpoint

-- 4. Better Auth account model. One row per user, provider_id = 'credential',
--    Argon2id hash in `password`. The token/scope columns are nullable and
--    unwritten in M1; they exist because the adapter builds queries from Better
--    Auth's field list. They are not OAuth support.
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id")
		REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint

-- 5. Better Auth verification model. Required by the model contract; M1
--    configures neither email verification nor password reset, so nothing
--    writes it.
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint

-- 6. Re-attach updated_at triggers to the recreated tables (0001 defines the
--    function; dropping the tables took their triggers with them).
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER verifications_set_updated_at BEFORE UPDATE ON verifications
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();
