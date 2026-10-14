-- Reverses 0005. DEVELOPMENT ONLY, and destructive.
--
-- Dropping these tables discards every extracted statement, every reconciliation
-- outcome and the entire provider cost ledger. The cost ledger is the only
-- record reconciling this system's spend against a provider invoice; there is no
-- way to rebuild it, because re-running extraction bills again.
--
-- Down migrations are never applied automatically (see migrations/README.md).

DROP TRIGGER IF EXISTS provider_calls_set_updated_at ON provider_calls;
DROP TRIGGER IF EXISTS statement_lines_set_updated_at ON statement_lines;
DROP TRIGGER IF EXISTS statements_set_updated_at ON statements;
DROP TRIGGER IF EXISTS extraction_runs_set_updated_at ON extraction_runs;

-- Child-first: composite foreign keys make the order load-bearing.
DROP TABLE IF EXISTS provider_calls;
DROP TABLE IF EXISTS statement_lines;
DROP TABLE IF EXISTS statements;
DROP TABLE IF EXISTS extraction_runs;

DROP TYPE IF EXISTS provider_call_outcome;
DROP TYPE IF EXISTS extraction_input_path;
DROP TYPE IF EXISTS extraction_run_status;

-- Added by 0005 to anchor the composite-key chain; nothing in M1 needs it.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_id_firm_unique;
