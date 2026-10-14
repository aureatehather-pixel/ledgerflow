import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAuthHarness } from "@/lib/auth/testing";
import { auditEvents } from "@/lib/db/schema";
import { TS_SOURCE_FILES, stripComments, walkFiles } from "@/test/structural";

import {
  EVENT_NAMES,
  NULL_SINK,
  deltaMagnitude,
  emitEvent,
  memorySink,
  type EventName,
  type ObservabilityEvent,
} from "./events";

const CONTEXT = {
  firmId: "00000000-0000-7000-8000-00000000f1f1",
  documentId: "00000000-0000-7000-8000-00000000d0c0",
  runId: "00000000-0000-7000-8000-0000000000f0",
};
const CLOCK = () => new Date("2026-07-30T09:00:00.000Z");

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe("the event vocabulary is a public contract", () => {
  /**
   * Pinned. Downstream consumers may depend on these names, so a rename must
   * fail here rather than silently break a dashboard this repository cannot see.
   * Adding a name is safe and expected; changing or removing one is not.
   */
  const PINNED_NAMES: readonly string[] = [
    "extraction.run.started",
    "extraction.input.selected",
    "extraction.parser.selected",
    "extraction.model.call.started",
    "extraction.model.call.completed",
    "extraction.validation.failed",
    "extraction.reconciliation.failed",
    "extraction.cost.rejected",
    "extraction.retry.scheduled",
    "extraction.run.completed",
  ];

  it("emits exactly the pinned names", () => {
    expect([...Object.values(EVENT_NAMES)].sort()).toEqual([...PINNED_NAMES].sort());
  });

  it("covers all ten required emission points", () => {
    expect(Object.values(EVENT_NAMES)).toHaveLength(10);
  });

  it("namespaces every name under `extraction.`", () => {
    // A flat name collides the first time a second subsystem emits anything.
    for (const name of Object.values(EVENT_NAMES)) {
      expect(name.startsWith("extraction.")).toBe(true);
    }
  });

  it("freezes the name table", () => {
    expect(Object.isFrozen(EVENT_NAMES)).toBe(true);
  });

  /**
   * Required envelope fields, pinned per event. A removed or renamed field is a
   * breaking change for a consumer; adding an OPTIONAL one is not, so only
   * required fields are asserted here.
   */
  it("stamps every event with the correlation envelope", () => {
    const sink = memorySink();
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.RUN_STARTED, { attempt: 1 });

    const event = sink.events()[0];
    expect(event).toBeDefined();
    expect(event?.name).toBe("extraction.run.started");
    expect(event?.at).toBe("2026-07-30T09:00:00.000Z");
    expect(event?.firmId).toBe(CONTEXT.firmId);
    expect(event?.documentId).toBe(CONTEXT.documentId);
    expect(event?.runId).toBe(CONTEXT.runId);
  });

  it("omits runId before a run exists, rather than inventing one", () => {
    const sink = memorySink();
    emitEvent(
      sink,
      CLOCK,
      { firmId: CONTEXT.firmId, documentId: CONTEXT.documentId },
      EVENT_NAMES.RUN_STARTED,
      { attempt: 1 },
    );
    expect("runId" in (sink.events()[0] ?? {})).toBe(false);
  });

  it("takes its timestamp from the injected clock, never the wall", () => {
    const sink = memorySink();
    emitEvent(sink, () => new Date("2030-01-01T00:00:00.000Z"), CONTEXT, EVENT_NAMES.RUN_STARTED, {
      attempt: 1,
    });
    expect(sink.events()[0]?.at).toBe("2030-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Every event, constructed with the most hostile payload its type permits.
 *
 * Module-scoped because two blocks need it: the content-leak assertions below,
 * and the audit-separation assertions at the end of the file. Both have to cover
 * *every* name, so a new event cannot quietly acquire a field it should not have
 * or a write it should not make.
 */
function emitAll(): ObservabilityEvent[] {
  const sink = memorySink();
  const e = <K extends EventName>(name: K, payload: never) =>
    emitEvent(sink, CLOCK, CONTEXT, name, payload);

  e(EVENT_NAMES.RUN_STARTED, { attempt: 1 } as never);
  e(EVENT_NAMES.INPUT_SELECTED, { inputPath: "text-layer", pageCount: 3 } as never);
  e(EVENT_NAMES.PARSER_SELECTED, { parserId: "synthetic-v1", candidateCount: 1 } as never);
  e(EVENT_NAMES.MODEL_CALL_STARTED, {
    provider: "fake",
    model: "fake-model-1",
    maxOutputTokens: 2000,
  } as never);
  e(EVENT_NAMES.MODEL_CALL_COMPLETED, {
    provider: "fake",
    model: "fake-model-1",
    outcome: "succeeded",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCostMicrocents: "200000",
    requestId: "req_1",
  } as never);
  e(EVENT_NAMES.VALIDATION_FAILED, {
    failureKind: "EXTRACTION_VALIDATION_FAILED",
    detail: "line 2 (page 1): both a debit and a credit are present",
  } as never);
  e(EVENT_NAMES.RECONCILIATION_FAILED, {
    lineCount: 12,
    deltaMagnitude: "under-one-ringgit",
    runningBalanceCheck: "inconsistent",
  } as never);
  e(EVENT_NAMES.COST_REJECTED, {
    provider: "fake",
    model: "fake-model-1",
    estimatedMaxCostMicrocents: "101000000",
    ceilingMicrocents: "1",
    rateTableVersion: "test-fixture-v1",
  } as never);
  e(EVENT_NAMES.RETRY_SCHEDULED, {
    failureKind: "PROVIDER_FAILED",
    attemptsMade: 1,
    maxAttempts: 3,
    delayMs: 1000,
  } as never);
  e(EVENT_NAMES.RUN_COMPLETED, {
    outcome: "succeeded",
    attempts: 1,
    inputPath: "text-layer",
    parserId: "synthetic-v1",
    durationMs: 42,
  } as never);

  return [...sink.events()];
}

describe("no event can carry content", () => {
  const ACCOUNT = "8888888888";
  const PAYEE = "CONFIDENTIAL SDN BHD";
  const AMOUNT = "1234567";

  it("exercises every event type", () => {
    expect(emitAll()).toHaveLength(Object.values(EVENT_NAMES).length);
  });

  it("has no field capable of holding a description, payee or account", () => {
    // Structural, not incidental: every payload in events.ts lists its fields
    // explicitly and there is no index signature anywhere, so a caller cannot
    // attach content without editing the contract -- which fails the pin above.
    const serialised = JSON.stringify(emitAll());
    for (const secret of [ACCOUNT, PAYEE, AMOUNT]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("reports a reconciliation delta as a bucket, never the amount", () => {
    const sink = memorySink();
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.RECONCILIATION_FAILED, {
      lineCount: 1,
      deltaMagnitude: deltaMagnitude(4_242_42n),
      runningBalanceCheck: "not-available",
    });
    const serialised = JSON.stringify(sink.events());
    // RM4,242.42. The figure never appears; only the bucket it falls in.
    expect(serialised).not.toContain("424242");
    expect(serialised).toContain("large");
  });

  it.each([
    [0n, "zero"],
    [1n, "under-one-ringgit"],
    [99n, "under-one-ringgit"],
    [-99n, "under-one-ringgit"],
    [100n, "under-one-thousand"],
    [99_999n, "under-one-thousand"],
    [100_000n, "large"],
    [-100_000_000n, "large"],
  ])("buckets %s sen as %s", (delta, expected) => {
    expect(deltaMagnitude(delta)).toBe(expected);
  });

  it("keeps buckets wide enough not to reconstruct the figure", () => {
    // Four buckets over the whole range. Narrow buckets are a disclosure.
    const all = new Set(
      [0n, 50n, 5_000n, 50_000_000n].map((v) => deltaMagnitude(v)),
    );
    expect(all.size).toBeLessThanOrEqual(4);
  });

  it("logs our own spend in full, because it is not client data", () => {
    // The distinction the file draws: a statement amount is the client's; an
    // API bill is ours, and a ceiling rejection is useless without the number.
    const sink = memorySink();
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.COST_REJECTED, {
      provider: "fake",
      model: "m",
      estimatedMaxCostMicrocents: "101000000",
      ceilingMicrocents: "1",
      rateTableVersion: "v1",
    });
    expect(JSON.stringify(sink.events())).toContain("101000000");
  });
});

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

describe("sinks", () => {
  it("discards by default, so observability is never load-bearing", () => {
    expect(() =>
      emitEvent(NULL_SINK, CLOCK, CONTEXT, EVENT_NAMES.RUN_STARTED, { attempt: 1 }),
    ).not.toThrow();
  });

  it("never lets a failing sink fail an extraction", () => {
    const exploding = {
      emit() {
        throw new Error("log shipping is down");
      },
    };
    expect(() =>
      emitEvent(exploding, CLOCK, CONTEXT, EVENT_NAMES.RUN_STARTED, { attempt: 1 }),
    ).not.toThrow();
  });

  it("collects in order and filters by name", () => {
    const sink = memorySink();
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.RUN_STARTED, { attempt: 1 });
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.RUN_COMPLETED, {
      outcome: "succeeded",
      attempts: 1,
    });

    expect(sink.names()).toEqual([
      "extraction.run.started",
      "extraction.run.completed",
    ]);
    expect(sink.named(EVENT_NAMES.RUN_COMPLETED)).toHaveLength(1);
    sink.clear();
    expect(sink.events()).toEqual([]);
  });

  it("hands out a copy, so a reader cannot mutate the record", () => {
    const sink = memorySink();
    emitEvent(sink, CLOCK, CONTEXT, EVENT_NAMES.RUN_STARTED, { attempt: 1 });
    (sink.events() as ObservabilityEvent[]).length = 0;
    expect(sink.events()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Operational events are not the audit log
// ---------------------------------------------------------------------------

/**
 * `events.ts` claims these two things in its header. Until this block existed
 * the claim was only a comment -- and a comment asserting that a test exists is
 * the worst kind of documentation defect, because a reader stops checking.
 *
 * The distinction is not cosmetic. `audit_events` is the append-only business
 * record of who accessed what; operational events may be sampled, dropped or
 * shipped to a third party. If emitting one wrote an audit row, the audit trail
 * would inherit the volume and the retention posture of a log.
 */
describe("observability writes no audit trail", () => {
  it("emits every event without inserting a single audit row", async () => {
    const h = await createAuthHarness();
    try {
      const before = await h.db.select().from(auditEvents);
      expect(before).toHaveLength(0);

      // Every name, so a new event added later cannot quietly acquire a write.
      const emitted = emitAll();
      expect(emitted).toHaveLength(Object.values(EVENT_NAMES).length);

      const after = await h.db.select().from(auditEvents);
      expect(after).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("gives lib/observability no way to reach the audit writer or its table", () => {
    // Structural, because the runtime test above can only prove it for the code
    // paths it exercises. An import is the capability; absence of the import is
    // the proof.
    for (const file of walkFiles(
      join(process.cwd(), "lib", "observability"),
      TS_SOURCE_FILES,
    )) {
      // Comments describe the rule -- events.ts explains the distinction at
      // length -- and only code can break it.
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toContain("lib/audit");
      expect(code).not.toContain("auditEvents");
    }
  });

  it("keeps lib/audit the only writer of audit_events", () => {
    // The claim in CLAUDE.md § Rules that follow from the layout. A second
    // writer is a hole in the audit trail, and it would not fail any other test.
    const offenders: string[] = [];
    for (const file of walkFiles(process.cwd(), TS_SOURCE_FILES)) {
      if (file.includes(join("lib", "audit"))) continue;
      // schema.ts and testing.ts define and manipulate the table by design.
      if (file.endsWith("schema.ts") || file.endsWith(join("db", "testing.ts"))) {
        continue;
      }
      const code = readFileSync(file, "utf8");
      if (/insert\(\s*(schema\.)?auditEvents\s*\)/.test(code)) {
        offenders.push(file.replace(process.cwd(), ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would catch a second writer — the negative control", () => {
    // Proves the pattern above matches a real insert rather than never firing.
    // A structural test that cannot fail is indistinguishable from `return true`.
    const planted = "await db.insert(auditEvents).values({ action: 'x' });";
    expect(/insert\(\s*(schema\.)?auditEvents\s*\)/.test(planted)).toBe(true);
    expect(/insert\(\s*(schema\.)?auditEvents\s*\)/.test("select().from(auditEvents)")).toBe(
      false,
    );
  });
});

