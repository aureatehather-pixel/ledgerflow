-- Upload state for documents.
--
-- PostgreSQL and object storage do not share a transaction, so there is always a
-- window where a row exists and its bytes do not. This column names that window
-- instead of pretending it does not exist:
--
--   pending -> the row is reserved, the object may or may not be written yet
--   ready   -> bytes are in storage and the document is visible
--   failed  -> the upload did not complete; the row is a record, not a document
--
-- Only 'ready' is externally visible. A row that never reaches it is invisible
-- rather than half-present, which is the whole point of the column.
--
-- Nothing here is about extraction, review or approval -- those are M2+ and
-- would be speculative now.

CREATE TYPE "public"."document_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint

-- DEFAULT 'pending' deliberately: a row created outside the upload path has not
-- been confirmed to have bytes behind it, so the safe default is invisible.
ALTER TABLE "documents"
	ADD COLUMN "status" "document_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint

-- Supports the visibility filter on every read path.
CREATE INDEX "documents_client_status_idx"
	ON "documents" USING btree ("client_id","status");--> statement-breakpoint

-- Retry idempotence. A user whose upload failed on a flaky connection and who
-- submits the same file again must not end up with two visible copies. Scoped to
-- ready + not-deleted so a failed attempt never blocks a later genuine one, and
-- so a soft-deleted document does not prevent re-uploading the same file.
CREATE UNIQUE INDEX "documents_client_sha256_ready_unique"
	ON "documents" USING btree ("client_id","sha256")
	WHERE "status" = 'ready' AND "deleted_at" IS NULL;
