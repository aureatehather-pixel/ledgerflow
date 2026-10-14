-- Development-only. Dropping `status` makes every document -- including ones
-- whose bytes were never written -- indistinguishable from a completed upload,
-- so do not run this against a database that has had any failed upload.

DROP INDEX IF EXISTS "documents_client_sha256_ready_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "documents_client_status_idx";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."document_status";
