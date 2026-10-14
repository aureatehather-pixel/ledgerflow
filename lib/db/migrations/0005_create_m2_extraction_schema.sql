-- M2a: extraction runs, canonical statements, statement lines, provider calls.
--
-- TENANT ISOLATION IS RELATIONAL, NOT ADVISORY.
--
-- Every table below carries firm_id AND reaches its parent through a COMPOSITE
-- foreign key that includes firm_id. A statement therefore cannot reference a
-- run belonging to another firm, and a line cannot reference a statement in
-- another firm, because the database rejects it -- not because application code
-- remembered to filter. This is the difference between carrying tenant identity
-- and enforcing it.
--
-- The chain is anchored at documents, which needs a UNIQUE (id, firm_id) for a
-- composite key to target. That is an additive constraint on an existing table:
-- id is already the primary key, so the pair is unique by construction and the
-- statement can never fail on existing data.
--
-- MONEY IS bigint. Sen for statement amounts, microcents for provider cost.
-- Never numeric, never double precision, never JSON. Drizzle reads both as
-- JavaScript bigint; lib/extract/persistence/codec.ts owns the conversion and
-- proves it round-trips above Number.MAX_SAFE_INTEGER.
--
-- WHAT IS DELIBERATELY ABSENT from every table here: GL account codes, tax
-- codes, posting state, reviewer or approval state, destination identifiers,
-- accounting-package fields, and billing. Those are M3a/M3b concepts and each
-- needs evidence this project does not have. provider_calls additionally holds
-- no prompt, no raw response and no extracted financial text.

-- Anchor for the composite-key chain.
ALTER TABLE documents ADD CONSTRAINT documents_id_firm_unique UNIQUE (id, firm_id);

CREATE TYPE extraction_run_status AS ENUM (
  'pending', 'running', 'succeeded', 'exception', 'failed'
);
CREATE TYPE extraction_input_path AS ENUM ('unknown', 'text_layer', 'image_only');
CREATE TYPE provider_call_outcome AS ENUM (
  'rejected_before_invocation',
  'provider_invocation_failed',
  'provider_output_malformed',
  'succeeded'
);

-- --------------------------------------------------------------------------
-- extraction_runs
-- --------------------------------------------------------------------------

CREATE TABLE extraction_runs (
  id             uuid PRIMARY KEY,
  firm_id        uuid NOT NULL REFERENCES firms (id) ON DELETE RESTRICT,
  client_id      uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  document_id    uuid NOT NULL,
  attempt        integer NOT NULL DEFAULT 1,
  status         extraction_run_status NOT NULL DEFAULT 'pending',
  input_path     extraction_input_path NOT NULL DEFAULT 'unknown',
  parser_id      text,
  started_at     timestamptz,
  completed_at   timestamptz,
  failure_kind   text,
  failure_detail text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extraction_runs_attempt_positive CHECK (attempt > 0),
  -- The document must belong to this run's firm. Enforced, not assumed.
  CONSTRAINT extraction_runs_document_fk
    FOREIGN KEY (document_id, firm_id) REFERENCES documents (id, firm_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX extraction_runs_id_firm_unique ON extraction_runs (id, firm_id);
CREATE INDEX extraction_runs_firm_status_idx ON extraction_runs (firm_id, status);
CREATE INDEX extraction_runs_client_idx ON extraction_runs (client_id);
CREATE UNIQUE INDEX extraction_runs_document_attempt_unique
  ON extraction_runs (firm_id, document_id, attempt);

-- At most one successful run per document. The idempotency backstop for
-- concurrent workers: two of them racing cannot both record success, because
-- the second INSERT violates this index.
CREATE UNIQUE INDEX extraction_runs_one_success_per_document
  ON extraction_runs (firm_id, document_id)
  WHERE status = 'succeeded';

-- --------------------------------------------------------------------------
-- statements
-- --------------------------------------------------------------------------

CREATE TABLE statements (
  id                   uuid PRIMARY KEY,
  firm_id              uuid NOT NULL REFERENCES firms (id) ON DELETE RESTRICT,
  run_id               uuid NOT NULL,
  document_id          uuid NOT NULL,
  account_reference    text NOT NULL,
  currency             text NOT NULL,
  period_start         date NOT NULL,
  period_end           date NOT NULL,
  opening_balance_sen  bigint NOT NULL,
  closing_balance_sen  bigint NOT NULL,
  page_count           integer NOT NULL,
  reconciled           boolean NOT NULL,
  computed_closing_sen bigint NOT NULL,
  delta_sen            bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT statements_currency_length CHECK (length(currency) = 3),
  CONSTRAINT statements_page_count_positive CHECK (page_count > 0),
  CONSTRAINT statements_period_ordered CHECK (period_start <= period_end),
  -- The reconciliation gate, restated at the database. There is no tolerance
  -- here either: reconciled is true exactly when the delta is zero.
  CONSTRAINT statements_reconciled_iff_zero_delta
    CHECK ((reconciled = true) = (delta_sen = 0)),
  CONSTRAINT statements_run_fk
    FOREIGN KEY (run_id, firm_id) REFERENCES extraction_runs (id, firm_id)
    ON DELETE RESTRICT,
  CONSTRAINT statements_document_fk
    FOREIGN KEY (document_id, firm_id) REFERENCES documents (id, firm_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX statements_id_firm_unique ON statements (id, firm_id);
CREATE UNIQUE INDEX statements_run_unique ON statements (firm_id, run_id);
CREATE INDEX statements_firm_document_idx ON statements (firm_id, document_id);

-- --------------------------------------------------------------------------
-- statement_lines
-- --------------------------------------------------------------------------

CREATE TABLE statement_lines (
  id                  uuid PRIMARY KEY,
  firm_id             uuid NOT NULL REFERENCES firms (id) ON DELETE RESTRICT,
  statement_id        uuid NOT NULL,
  line_index          integer NOT NULL,
  transaction_date    date NOT NULL,
  date_raw            text NOT NULL,
  description         text NOT NULL,
  debit_sen           bigint NOT NULL,
  credit_sen          bigint NOT NULL,
  running_balance_sen bigint,
  source_page         integer NOT NULL,
  source_locator      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT statement_lines_debit_non_negative CHECK (debit_sen >= 0),
  CONSTRAINT statement_lines_credit_non_negative CHECK (credit_sen >= 0),
  -- A transaction moves money one way. Both populated means the debit and
  -- credit columns were read into each other; neither means it is not a
  -- transaction at all.
  CONSTRAINT statement_lines_exactly_one_side
    CHECK ((debit_sen = 0) <> (credit_sen = 0)),
  CONSTRAINT statement_lines_page_positive CHECK (source_page > 0),
  CONSTRAINT statement_lines_statement_fk
    FOREIGN KEY (statement_id, firm_id) REFERENCES statements (id, firm_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX statement_lines_statement_index_unique
  ON statement_lines (firm_id, statement_id, line_index);
CREATE INDEX statement_lines_statement_idx ON statement_lines (firm_id, statement_id);

-- --------------------------------------------------------------------------
-- provider_calls
-- --------------------------------------------------------------------------
--
-- Operational metadata only. No prompt column, no response column, no text
-- column that could hold a transaction. failure_detail is admitted because the
-- failure taxonomy guarantees it names shape rather than content.

CREATE TABLE provider_calls (
  id                            uuid PRIMARY KEY,
  firm_id                       uuid NOT NULL REFERENCES firms (id) ON DELETE RESTRICT,
  run_id                        uuid NOT NULL,
  provider                      text NOT NULL,
  model                         text NOT NULL,
  pricing_platform              text NOT NULL,
  pricing_inference             text NOT NULL,
  pricing_routing               text NOT NULL,
  pricing_cache_write_ttl       text NOT NULL,
  rate_table_version            text NOT NULL,
  rate_effective_from           date,
  request_id                    text,
  input_tokens                  integer,
  output_tokens                 integer,
  cache_creation_tokens         integer,
  cache_read_tokens             integer,
  currency                      text NOT NULL,
  estimated_max_cost_microcents bigint,
  actual_cost_microcents        bigint,
  started_at                    timestamptz NOT NULL,
  completed_at                  timestamptz NOT NULL,
  outcome                       provider_call_outcome NOT NULL,
  failure_kind                  text,
  failure_detail                text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_calls_currency_length CHECK (length(currency) = 3),
  CONSTRAINT provider_calls_costs_non_negative
    CHECK (coalesce(estimated_max_cost_microcents, 0) >= 0
       AND coalesce(actual_cost_microcents, 0) >= 0),
  CONSTRAINT provider_calls_ordered CHECK (completed_at >= started_at),
  CONSTRAINT provider_calls_tokens_non_negative
    CHECK (coalesce(input_tokens, 0) >= 0 AND coalesce(output_tokens, 0) >= 0
       AND coalesce(cache_creation_tokens, 0) >= 0
       AND coalesce(cache_read_tokens, 0) >= 0),
  CONSTRAINT provider_calls_run_fk
    FOREIGN KEY (run_id, firm_id) REFERENCES extraction_runs (id, firm_id)
    ON DELETE RESTRICT
);

CREATE INDEX provider_calls_firm_run_idx ON provider_calls (firm_id, run_id);
CREATE INDEX provider_calls_firm_started_idx ON provider_calls (firm_id, started_at);
CREATE UNIQUE INDEX provider_calls_request_id_unique
  ON provider_calls (firm_id, request_id)
  WHERE request_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- updated_at triggers (set_updated_at() is defined in migration 0001)
-- --------------------------------------------------------------------------

CREATE TRIGGER extraction_runs_set_updated_at BEFORE UPDATE ON extraction_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER statements_set_updated_at BEFORE UPDATE ON statements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER statement_lines_set_updated_at BEFORE UPDATE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER provider_calls_set_updated_at BEFORE UPDATE ON provider_calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
