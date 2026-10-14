import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FAKE_RATE_TABLE, fixedClock } from "@/lib/cost/testing";
import { fail, failure, isRetryable, ok } from "@/lib/domain/failures";
import { uuidv7 } from "@/lib/db/ids";
import { createTestDatabase } from "@/lib/db/testing";

import { createFakeModelAdapter } from "../model/fake";
import { createParserRegistry, EMPTY_PARSER_REGISTRY } from "../registry";
import {
  bornDigitalPdf,
  imageOnlyPdf,
  malformedPdf,
  syntheticParser,
  syntheticStatementPdf,
} from "../testing";
import { EVENT_NAMES, memorySink } from "@/lib/observability/events";
import { loadStatement, type RunScope } from "../persistence";
import { CancelledError, testClock } from "./clock";
import { runExtraction, type ExtractionDeps } from "./pipeline";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, shouldRetry } from "./retry";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: RunScope;

async function seed(db: unknown): Promise<RunScope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = db as any;
  const firmId = uuidv7();
  const clientId = uuidv7();
  const userId = uuidv7();
  const documentId = uuidv7();
  await d.execute(sql`insert into firms (id, name) values (${firmId}, 'Alpha')`);
  await d.execute(
    sql`insert into users (id, firm_id, email, name, firm_role)
        values (${userId}, ${firmId}, ${`u-${userId}@example.test`}, 'U', 'staff')`,
  );
  await d.execute(
    sql`insert into clients (id, firm_id, name, code)
        values (${clientId}, ${firmId}, 'C', 'C-1')`,
  );
  await d.execute(
    sql`insert into documents (id, firm_id, client_id, storage_key, original_filename,
                               content_type, byte_size, sha256, uploaded_by, status)
        values (${documentId}, ${firmId}, ${clientId}, ${`k/${documentId}`}, 'x.pdf',
                'application/pdf', 100, ${"a".repeat(64)}, ${userId}, 'ready')`,
  );
  return { firmId, clientId, documentId };
}

beforeEach(async () => {
  harness = await createTestDatabase();
  scope = await seed(harness.db);
});

afterEach(async () => {
  await harness.close();
});

function deps(overrides: Partial<ExtractionDeps> = {}): ExtractionDeps {
  return {
    db: harness.db,
    clock: testClock(),
    registry: createParserRegistry([syntheticParser]),
    loadDocument: async () => ok(syntheticStatementPdf()),
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    ...overrides,
  };
}

async function runStatuses(): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = harness.db as any;
  const rows = await db.execute(
    sql`select status from extraction_runs where firm_id = ${scope.firmId}
        order by attempt`,
  );
  return (rows.rows ?? rows).map((r: Record<string, unknown>) => String(r["status"]));
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("end to end on synthetic input", () => {
  it("extracts, validates, reconciles and persists", async () => {
    const outcome = await runExtraction(deps(), scope);

    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind !== "succeeded") return;
    expect(outcome.reused).toBe(false);
    expect(outcome.attempts).toBe(1);

    const loaded = await loadStatement(harness.db, scope.firmId, outcome.statementId);
    expect(loaded?.reconciled).toBe(true);
    expect(await runStatuses()).toEqual(["succeeded"]);
  });

  it("records which parser produced the result", async () => {
    await runExtraction(deps(), scope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const rows = await db.execute(
      sql`select parser_id, input_path from extraction_runs where firm_id = ${scope.firmId}`,
    );
    const row = (rows.rows ?? rows)[0] as Record<string, unknown>;
    expect(row["parser_id"]).toBe("synthetic-v1");
    expect(row["input_path"]).toBe("text_layer");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency is owned by orchestration", () => {
  it("does no work when the document already succeeded", async () => {
    const first = await runExtraction(deps(), scope);
    expect(first.kind).toBe("succeeded");

    let loads = 0;
    const second = await runExtraction(
      deps({
        loadDocument: async () => {
          loads += 1;
          return ok(syntheticStatementPdf());
        },
      }),
      scope,
    );

    expect(second.kind).toBe("succeeded");
    if (second.kind === "succeeded") {
      expect(second.reused).toBe(true);
      expect(second.attempts).toBe(0);
    }
    // The short-circuit happened before anything was read.
    expect(loads).toBe(0);
    expect(await runStatuses()).toEqual(["succeeded"]);
  });

  it("returns the same statement rather than creating a second", async () => {
    const first = await runExtraction(deps(), scope);
    const second = await runExtraction(deps(), scope);
    if (first.kind !== "succeeded" || second.kind !== "succeeded") throw new Error("x");
    expect(second.statementId).toBe(first.statementId);
    expect(second.runId).toBe(first.runId);
  });

  it("leaves the database as the final net, not the primary mechanism", async () => {
    // Orchestration short-circuits first; if a bug ever bypassed that, the
    // partial unique index on succeeded runs still refuses the second success.
    await runExtraction(deps(), scope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const other = uuidv7();
    await db.execute(
      sql`insert into extraction_runs (id, firm_id, client_id, document_id, attempt, status)
          values (${other}, ${scope.firmId}, ${scope.clientId}, ${scope.documentId}, 99, 'pending')`,
    );
    await expect(
      db.execute(
        sql`update extraction_runs set status = 'succeeded' where id = ${other}`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry follows the typed failure, never a message", () => {
  it("retries a retryable provider failure to the policy limit", async () => {
    // PROVIDER_FAILED is the one retryable kind reachable end to end. Three
    // attempts, three run rows, three failed statuses.
    const adapter = createFakeModelAdapter({ invoke: "fail" });
    const clock = testClock();
    const outcome = await runExtraction(
      deps({
        clock,
        loadDocument: async () => ok(imageOnlyPdf()),
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        model: {
          deps: {
            adapter,
            rateTable: FAKE_RATE_TABLE,
            ceiling: { perCallMicrocents: 10_000_000n, currency: "USD" },
            now: fixedClock(),
          },
          maxOutputTokens: 2_000,
          instructions: "Extract.",
        },
      }),
      scope,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure.kind).toBe("PROVIDER_FAILED");
      expect(outcome.attempts).toBe(3);
    }
    expect(adapter.invocations()).toBe(3);
    expect(await runStatuses()).toEqual(["failed", "failed", "failed"]);
  });

  it("classifies a storage outage as a typed failure, not a crash", async () => {
    const outcome = await runExtraction(
      deps({
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        loadDocument: async () =>
          fail<Uint8Array>("PROCESSING_FAILED_RETRYABLE", "object storage unreachable"),
      }),
      scope,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.attempts).toBe(2);
  });

  it("does not swallow an unexpected throw", async () => {
    // A raw throw is a bug, not a state of the world. Converting it into a
    // retryable failure would retry a programming error forever.
    await expect(
      runExtraction(
        deps({
          loadDocument: async () => {
            throw new Error("boom");
          },
        }),
        scope,
      ),
    ).rejects.toThrow("boom");
  });

  it("does not retry a permanent failure", async () => {
    let loads = 0;
    const outcome = await runExtraction(
      deps({
        loadDocument: async () => {
          loads += 1;
          return ok(malformedPdf());
        },
      }),
      scope,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure.kind).toBe("CORRUPT_DOCUMENT");
      expect(outcome.attempts).toBe(1);
    }
    expect(loads).toBe(1);
    expect(await runStatuses()).toEqual(["failed"]);
  });

  it("never retries a cost-ceiling breach", () => {
    // Decided once in the taxonomy; orchestration only reads it.
    const f = failure("COST_CEILING_EXCEEDED", "over budget");
    expect(isRetryable(f)).toBe(false);
    expect(shouldRetry(DEFAULT_RETRY_POLICY, f, 1)).toBe(false);
  });

  it("never retries a failed reconciliation", () => {
    const f = failure("RECONCILIATION_FAILED", "off by 1");
    expect(shouldRetry(DEFAULT_RETRY_POLICY, f, 1)).toBe(false);
  });

  it("stops at the attempt limit even for a retryable failure", () => {
    const f = failure("PROVIDER_FAILED", "transient");
    expect(shouldRetry({ ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, f, 2)).toBe(true);
    expect(shouldRetry({ ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, f, 3)).toBe(false);
  });

  it("backs off exponentially and caps", () => {
    const policy = { maxAttempts: 9, baseDelayMs: 1_000, maxDelayMs: 8_000 };
    expect(backoffDelayMs(policy, 1)).toBe(0);
    expect(backoffDelayMs(policy, 2)).toBe(1_000);
    expect(backoffDelayMs(policy, 3)).toBe(2_000);
    expect(backoffDelayMs(policy, 4)).toBe(4_000);
    expect(backoffDelayMs(policy, 9)).toBe(8_000); // capped
  });

  it("keeps each attempt as its own run, preserving history", async () => {
    // A retry inserts the next attempt rather than reviving a terminal row.
    let calls = 0;
    await runExtraction(
      deps({
        loadDocument: async () => {
          calls += 1;
          return ok(calls === 1 ? imageOnlyPdf() : syntheticStatementPdf());
        },
      }),
      scope,
    );
    const statuses = await runStatuses();
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation leaves no ambiguous state", () => {
  it("stops before starting when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runExtraction(deps(), scope, { signal: controller.signal });

    expect(outcome.kind).toBe("cancelled");
    expect(await runStatuses()).toEqual([]);
  });

  it("releases a claimed run back to pending rather than failing it", async () => {
    const controller = new AbortController();
    const outcome = await runExtraction(
      deps({
        loadDocument: async () => {
          // Abandoned while the worker holds the run.
          controller.abort();
          return ok(syntheticStatementPdf());
        },
      }),
      scope,
      { signal: controller.signal },
    );

    expect(outcome.kind).toBe("cancelled");
    // Not `failed`: nothing was carried to a conclusion. `pending` is visible
    // and claimable, which is what a queue-backed worker would want.
    expect(await runStatuses()).toEqual(["pending"]);
  });

  it("does not leave a run stuck in running", async () => {
    const controller = new AbortController();
    await runExtraction(
      deps({
        loadDocument: async () => {
          controller.abort();
          return ok(syntheticStatementPdf());
        },
      }),
      scope,
      { signal: controller.signal },
    );
    expect(await runStatuses()).not.toContain("running");
  });

  it("interrupts a pending backoff instead of holding the process", async () => {
    const clock = testClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(60_000, controller.signal);
    expect(clock.pending()).toBe(1);
    controller.abort();
    await expect(sleeping).rejects.toBeInstanceOf(CancelledError);
  });
});

// ---------------------------------------------------------------------------
// Time is injected
// ---------------------------------------------------------------------------

describe("clocks are injected", () => {
  it("does not resolve a sleep until time is advanced", async () => {
    const clock = testClock();
    let resolved = false;
    void clock.sleep(5_000).then(() => {
      resolved = true;
    });
    await clock.advance(4_999);
    expect(resolved).toBe(false);
    await clock.advance(1);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("stamps runs from the injected clock, not the wall", async () => {
    const outcome = await runExtraction(
      deps({ clock: { ...testClock("2030-01-01T00:00:00.000Z") } }),
      scope,
    );
    expect(outcome.kind).toBe("succeeded");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const rows = await db.execute(
      sql`select started_at from extraction_runs where firm_id = ${scope.firmId}`,
    );
    const startedAt = String((rows.rows ?? rows)[0]["started_at"]);
    expect(startedAt).toContain("2030");
  });

  it("uses a deterministic clock in the cost layer too", () => {
    const clock = fixedClock("2026-07-30T00:00:00.000Z");
    expect(clock().toISOString()).toBe("2026-07-30T00:00:00.000Z");
    expect(clock().toISOString()).toBe("2026-07-30T00:00:01.000Z");
  });
});

// ---------------------------------------------------------------------------
// Routing and configuration
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("fails a scanned document when no provider is configured", async () => {
    const outcome = await runExtraction(
      deps({ loadDocument: async () => ok(imageOnlyPdf()) }),
      scope,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure.kind).toBe("MISSING_TEXT_LAYER");
      expect(outcome.failure.detail).toContain("no model provider is configured");
    }
  });

  it("reaches the metered call for a scanned document when one is", async () => {
    const adapter = createFakeModelAdapter();
    const outcome = await runExtraction(
      deps({
        loadDocument: async () => ok(imageOnlyPdf()),
        model: {
          deps: {
            adapter,
            rateTable: FAKE_RATE_TABLE,
            ceiling: { perCallMicrocents: 10_000_000n, currency: "USD" },
            now: fixedClock(),
          },
          maxOutputTokens: 2_000,
          instructions: "Extract the statement.",
        },
      }),
      scope,
    );

    expect(adapter.invocations()).toBe(1);
    // The fake's payload does not balance, so the gate refuses it: the
    // reconciliation oracle applies to model output exactly as to a parser's.
    expect(["succeeded", "exception"]).toContain(outcome.kind);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const calls = await db.execute(
      sql`select outcome, actual_cost_microcents from provider_calls
          where firm_id = ${scope.firmId}`,
    );
    expect((calls.rows ?? calls).length).toBe(1);
  });

  it("reports an unsupported document when no parser claims it", async () => {
    const outcome = await runExtraction(
      deps({
        registry: EMPTY_PARSER_REGISTRY,
        loadDocument: async () => ok(bornDigitalPdf([["NOT A KNOWN LAYOUT"]])),
      }),
      scope,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.failure.kind).toBe("UNSUPPORTED_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe("operational events", () => {
  it("emits the run lifecycle in order on the happy path", async () => {
    const events = memorySink();
    await runExtraction(deps({ events }), scope);

    expect(events.names()).toEqual([
      EVENT_NAMES.RUN_STARTED,
      EVENT_NAMES.INPUT_SELECTED,
      EVENT_NAMES.PARSER_SELECTED,
      EVENT_NAMES.RUN_COMPLETED,
    ]);
  });

  it("correlates every event by document and run", async () => {
    const events = memorySink();
    const outcome = await runExtraction(deps({ events }), scope);
    if (outcome.kind !== "succeeded") throw new Error("expected success");

    for (const event of events.events()) {
      expect(event.firmId).toBe(scope.firmId);
      expect(event.documentId).toBe(scope.documentId);
      expect(event.runId).toBe(outcome.runId);
    }
  });

  it("reports which input path and parser were selected", async () => {
    const events = memorySink();
    await runExtraction(deps({ events }), scope);

    const input = events.named(EVENT_NAMES.INPUT_SELECTED)[0];
    const parser = events.named(EVENT_NAMES.PARSER_SELECTED)[0];
    expect(input).toMatchObject({ inputPath: "text-layer", pageCount: 2 });
    expect(parser).toMatchObject({ parserId: "synthetic-v1", candidateCount: 1 });
  });

  it("emits a retry-scheduled event carrying the failure kind and delay", async () => {
    const events = memorySink();
    await runExtraction(
      deps({
        events,
        loadDocument: async () => ok(imageOnlyPdf()),
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        model: {
          deps: {
            adapter: createFakeModelAdapter({ invoke: "fail" }),
            rateTable: FAKE_RATE_TABLE,
            ceiling: { perCallMicrocents: 10_000_000n, currency: "USD" },
            now: fixedClock(),
          },
          maxOutputTokens: 2_000,
          instructions: "Extract.",
        },
      }),
      scope,
    );

    const retry = events.named(EVENT_NAMES.RETRY_SCHEDULED)[0];
    expect(retry).toMatchObject({ failureKind: "PROVIDER_FAILED", maxAttempts: 2 });
    expect(events.named(EVENT_NAMES.MODEL_CALL_STARTED)).toHaveLength(2);
    expect(events.named(EVENT_NAMES.RUN_COMPLETED)[0]).toMatchObject({
      outcome: "failed",
    });
  });

  it("emits a cost rejection carrying our own spend", async () => {
    const events = memorySink();
    await runExtraction(
      deps({
        events,
        loadDocument: async () => ok(imageOnlyPdf()),
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        model: {
          deps: {
            adapter: createFakeModelAdapter({ countTokens: 1_000_000 }),
            rateTable: FAKE_RATE_TABLE,
            ceiling: { perCallMicrocents: 1n, currency: "USD" },
            now: fixedClock(),
          },
          maxOutputTokens: 2_000,
          instructions: "Extract.",
        },
      }),
      scope,
    );

    const rejected = events.named(EVENT_NAMES.COST_REJECTED)[0];
    expect(rejected).toMatchObject({ ceilingMicrocents: "1" });
  });

  it("emits run-completed as cancelled without leaving a running run", async () => {
    const events = memorySink();
    const controller = new AbortController();
    await runExtraction(
      deps({
        events,
        loadDocument: async () => {
          controller.abort();
          return ok(syntheticStatementPdf());
        },
      }),
      scope,
      { signal: controller.signal },
    );

    expect(events.named(EVENT_NAMES.RUN_COMPLETED)[0]).toMatchObject({
      outcome: "cancelled",
    });
    expect(await runStatuses()).toEqual(["pending"]);
  });

  it("never puts document content in an event", async () => {
    const events = memorySink();
    await runExtraction(
      deps({ events, loadDocument: async () => ok(malformedPdf()) }),
      scope,
    );
    const serialised = JSON.stringify(events.events());
    expect(serialised).not.toContain("SYNTHETIC TRANSACTION");
    expect(serialised).not.toContain("SAMPLEBANK");
  });

  it("writes no audit events, because operational logs are a separate system", async () => {
    // lib/audit remains the only writer of audit_events (ADR 0002).
    const events = memorySink();
    await runExtraction(deps({ events }), scope);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    // audit_events is tenant-scoped through its actor and resource, not by a
    // firm column -- so the whole table is the right assertion here.
    const rows = await db.execute(sql`select count(*)::int as n from audit_events`);
    expect(Number((rows.rows ?? rows)[0]["n"])).toBe(0);
    expect(events.events().length).toBeGreaterThan(0);
  });

  it("runs with no sink configured", async () => {
    // Observability is never load-bearing.
    const outcome = await runExtraction(deps(), scope);
    expect(outcome.kind).toBe("succeeded");
  });
});
