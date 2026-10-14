/**
 * Operational events.
 *
 * ## This is a public contract
 *
 * Event names and payload shapes are treated as though something downstream
 * already depends on them — a dashboard, an alert, a query. **Evolution is
 * additive only:**
 *
 *   - Adding a new event name is safe.
 *   - Adding an **optional** field to an existing payload is safe.
 *   - Renaming an event, renaming a field, removing a field, changing a field's
 *     type, or narrowing an enum is a **breaking change**. Do not do it. Add a
 *     new event name and leave the old one emitting.
 *
 * `events.test.ts` pins the full set of names and every payload's required
 * fields, so a rename fails the suite rather than silently breaking a consumer
 * that this repository cannot see.
 *
 * ## What may never appear in an event
 *
 * No secret. No document content. No description text. No account reference.
 * **No amount from a client's statement.**
 *
 * That last one costs something, so it is worth stating how it is handled
 * rather than pretending the need does not exist. Knowing a statement was out by
 * one sen rather than fifty thousand ringgit matters operationally, so
 * `extraction.reconciliation.failed` carries a **magnitude class** — an
 * enumerated bucket — instead of the delta. The signal survives; the client's
 * figure does not leave the database.
 *
 * **Our own spend is not client data** and is logged in full: the cost of a
 * model call is this project's bill, not anything from a statement, and a
 * ceiling rejection is useless without the number that caused it.
 *
 * ## Not the audit log
 *
 * These are operational: they answer "what is the pipeline doing?" and may be
 * sampled, dropped or shipped anywhere. `lib/audit` is the immutable business
 * record of who accessed what, is append-only at the database, and remains the
 * only writer of `audit_events`. A test asserts emitting events writes none.
 */

/** Every event name. Additive only — see the contract note above. */
export const EVENT_NAMES = Object.freeze({
  RUN_STARTED: "extraction.run.started",
  INPUT_SELECTED: "extraction.input.selected",
  PARSER_SELECTED: "extraction.parser.selected",
  MODEL_CALL_STARTED: "extraction.model.call.started",
  MODEL_CALL_COMPLETED: "extraction.model.call.completed",
  VALIDATION_FAILED: "extraction.validation.failed",
  RECONCILIATION_FAILED: "extraction.reconciliation.failed",
  COST_REJECTED: "extraction.cost.rejected",
  RETRY_SCHEDULED: "extraction.retry.scheduled",
  RUN_COMPLETED: "extraction.run.completed",
} as const);

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/**
 * Correlation, present on every event.
 *
 * `runId` is optional because the earliest events precede the run row. Nothing
 * else is optional: an event that cannot be traced to a tenant and a document is
 * not useful and is a privacy question waiting to happen.
 */
export interface EventEnvelope {
  readonly name: EventName;
  /** ISO-8601, from the injected clock. Never `Date.now()`. */
  readonly at: string;
  readonly firmId: string;
  readonly documentId: string;
  readonly runId?: string;
}

/**
 * How far out a reconciliation was, without saying by how much.
 *
 * Buckets are wide on purpose: narrow ones reconstruct the figure.
 */
export type DeltaMagnitude = "zero" | "under-one-ringgit" | "under-one-thousand" | "large";

export function deltaMagnitude(deltaSen: bigint): DeltaMagnitude {
  const magnitude = deltaSen < 0n ? -deltaSen : deltaSen;
  if (magnitude === 0n) return "zero";
  if (magnitude < 100n) return "under-one-ringgit";
  if (magnitude < 100_000n) return "under-one-thousand";
  return "large";
}

// ---------------------------------------------------------------------------
// Payloads — closed field sets, no index signatures
// ---------------------------------------------------------------------------
//
// Every payload lists its fields explicitly. There is no `Record<string,
// unknown>` and no index signature anywhere in this file, so a caller cannot
// attach an arbitrary value to an event without editing this contract — and
// editing it fails the pinning test until the change is deliberate.

export type EventPayloads = {
  [EVENT_NAMES.RUN_STARTED]: {
    readonly attempt: number;
  };
  [EVENT_NAMES.INPUT_SELECTED]: {
    readonly inputPath: "text-layer" | "image-only";
    readonly pageCount: number;
  };
  [EVENT_NAMES.PARSER_SELECTED]: {
    readonly parserId: string;
    readonly candidateCount: number;
  };
  [EVENT_NAMES.MODEL_CALL_STARTED]: {
    readonly provider: string;
    readonly model: string;
    readonly maxOutputTokens: number;
  };
  [EVENT_NAMES.MODEL_CALL_COMPLETED]: {
    readonly provider: string;
    readonly model: string;
    readonly outcome: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly cacheReadTokens?: number;
    /** Our bill, not client data. */
    readonly actualCostMicrocents?: string;
    readonly requestId?: string;
  };
  [EVENT_NAMES.VALIDATION_FAILED]: {
    readonly failureKind: string;
    /** Bounded and content-free by construction — see lib/domain/failures.ts. */
    readonly detail: string;
  };
  [EVENT_NAMES.RECONCILIATION_FAILED]: {
    readonly lineCount: number;
    /** A bucket, never the delta. */
    readonly deltaMagnitude: DeltaMagnitude;
    readonly runningBalanceCheck: string;
  };
  [EVENT_NAMES.COST_REJECTED]: {
    readonly provider: string;
    readonly model: string;
    /** Our bill. Useless without the number. */
    readonly estimatedMaxCostMicrocents: string;
    readonly ceilingMicrocents: string;
    readonly rateTableVersion: string;
  };
  [EVENT_NAMES.RETRY_SCHEDULED]: {
    readonly failureKind: string;
    readonly attemptsMade: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
  };
  [EVENT_NAMES.RUN_COMPLETED]: {
    readonly outcome: "succeeded" | "exception" | "failed" | "cancelled";
    readonly attempts: number;
    readonly inputPath?: "text-layer" | "image-only";
    readonly parserId?: string;
    readonly durationMs?: number;
  };
};

/** One emitted event: envelope plus its payload, discriminated by `name`. */
export type ObservabilityEvent = {
  [K in EventName]: EventEnvelope & { readonly name: K } & EventPayloads[K];
}[EventName];

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

/**
 * Where events go.
 *
 * A port, deliberately. Shipping to a log aggregator is a deployment decision
 * (M5); wiring one in now would be an integration nobody has run. `no-console`
 * also forbids the obvious placeholder, which is the correct pressure.
 *
 * `emit` returns nothing and must not throw: observability that can fail a run
 * is worse than no observability.
 */
export interface EventSink {
  emit(event: ObservabilityEvent): void;
}

/** Discards everything. The default, so observability is never load-bearing. */
export const NULL_SINK: EventSink = Object.freeze({
  emit: () => undefined,
});

export interface MemoryEventSink extends EventSink {
  readonly events: () => readonly ObservabilityEvent[];
  readonly named: (name: EventName) => readonly ObservabilityEvent[];
  readonly names: () => readonly EventName[];
  readonly clear: () => void;
}

/** Collects events in order. For tests and for a future in-process reader. */
export function memorySink(): MemoryEventSink {
  let collected: ObservabilityEvent[] = [];
  return {
    emit(event) {
      collected.push(event);
    },
    events: () => [...collected],
    named: (name) => collected.filter((e) => e.name === name),
    names: () => collected.map((e) => e.name),
    clear: () => {
      collected = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export interface EventContext {
  readonly firmId: string;
  readonly documentId: string;
  readonly runId?: string;
}

/**
 * Stamps the envelope and emits.
 *
 * A sink throwing must not fail an extraction, so the call is guarded. The
 * failure is deliberately swallowed rather than logged: the only thing available
 * to log it with is the sink that just failed.
 */
export function emitEvent<K extends EventName>(
  sink: EventSink,
  now: () => Date,
  context: EventContext,
  name: K,
  payload: EventPayloads[K],
): void {
  const event = {
    name,
    at: now().toISOString(),
    firmId: context.firmId,
    documentId: context.documentId,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...payload,
  } as ObservabilityEvent;

  try {
    sink.emit(event);
  } catch {
    // Observability is never load-bearing.
  }
}
