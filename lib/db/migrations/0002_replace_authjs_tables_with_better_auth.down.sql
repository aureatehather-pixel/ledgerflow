-- ============================================================================
--  DESTRUCTIVE. DEVELOPMENT ONLY. THIS IS NOT A DATA-REVERSIBLE ROLLBACK.
-- ============================================================================
--
-- Running this after any authentication data exists PERMANENTLY DELETES:
--
--   * every Better Auth account row, including every Argon2id PASSWORD HASH
--     (accounts.password) -- users will be unable to log in and their
--     passwords cannot be recovered or re-derived from anything;
--   * every active session -- all users are signed out irrecoverably;
--   * every verification record.
--
-- It restores the *structure* of the superseded Auth.js tables so that
-- migration 0002 can be replayed. It restores NO DATA, and the tables it
-- recreates were never used by any code that still exists in this repository.
--
-- Do not run this against a provisioned environment to "undo" an upgrade. Take
-- a snapshot first and restore from that instead (data.md, Backups). The only
-- legitimate use is resetting a local development database.
--
-- ============================================================================

DROP TRIGGER IF EXISTS verifications_set_updated_at ON verifications;--> statement-breakpoint
DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;--> statement-breakpoint

DROP TABLE IF EXISTS "verifications";--> statement-breakpoint
DROP TABLE IF EXISTS "accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "sessions";--> statement-breakpoint

-- Recreate the Auth.js-shaped tables as they stood after migration 0000.
-- Structure only. They will be empty.
CREATE TABLE "user_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id")
		REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint

CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id")
		REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint

CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id")
		REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_unique" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint

CREATE TRIGGER user_credentials_set_updated_at BEFORE UPDATE ON user_credentials
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
	FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "image";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified";
