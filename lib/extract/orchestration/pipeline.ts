/**
 * The extraction pipeline.
 *
 *   bytes -> input path -> parser or model -> validate -> reconcile -> persist
 *
 * **Orchestration owns idempotency; the database is the net.** Before any work,
 * a completed run for the document short-circuits the whole thing. Each attempt
 * then claims its run with a conditional UPDATE, so a second caller loses the
 * race rather than duplicating work. The unique index on succeeded runs sits
 * underneath both and would catch a bug in either.
 *
 * **No status strings.** Every lifecycle move goes through `machine.transition`,
 * which refuses an illegal one immediately.
 *
 * **Retries create new runs.** A retry inserts the next attempt rather than
 * reviving a terminal row, so the history of what was tried survives.
 *
 * **Queue-compatible without a queue.** Nothing here schedules itself: there is
 * no timer, no polling loop and no background process. The caller drives, and a
 * future worker would replace *the caller* rather than this module. `claimRun`
 * and the `pending` state are already the shape such a worker needs.
 *
 * **Cancellation leaves no ambiguous state.** The signal is checked between
 * every step and passed into the provider, and an abandoned run is *released*
 * back to `pending` rather than marked failed — the work was never carried to a
 * conclusion, and recording a failure would misreport it.
 */

import {
  publicFailure,
  type Failure,
  type PublicFailure,
  type Result,
} from "@/lib/domain/failures";
import { validateStatement } from "@/lib/domain/statement";
import { reconcile } from "@/lib/reconcile";

import { extractPdfText } from "../input/pdf";
import type { InputLimits } from "../input/limits";
import type { MeteredInvokeDeps } from "../model/invoke";
import { meteredInvoke } from "../model/invoke";
import type { ExtractedDocument } from "../port";
import type { ParserRegistry } from "../registry";
import {
  claimRun,
  completeExtractionRun,
  createExtractionRun,
  findStatementForRun,
  findSucceededRun,
  nextAttemptNumber,
  releaseRun,
  saveProviderCall,
  saveStatement,
  type RunScope,
} from "../persistence";
import {
  EVENT_NAMES,
  NULL_SINK,
  deltaMagnitude,
  emitEvent,
  type EventContext,
  type EventSink,
} from "@/lib/observability/events";
import { checkCancelled, type Clock } from "./clock";
import { transition, type RunState } from "./machine";
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  shouldRetry,
  type RetryPolicy,
} from "./retry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface ModelConfiguration {
  readonly deps: MeteredInvokeDeps;
  readonly maxOutputTokens: number;
  readonly instructions: string;
}

export interface ExtractionDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly registry: ParserRegistry;
  /**
   * Fetches the document bytes. Injected so storage stays behind its own port.
   *
   * Returns a `Result` rather than throwing, so a storage outage arrives as a
   * classifiable failure the retry policy can act on. A raw throw from here is
   * treated as a bug and propagates: swallowing it would misreport a programming
   * error as a transient one and retry it forever.
   */
  readonly loadDocument: (scope: RunScope) => Promise<Result<Uint8Array>>;
  /** Absent means no provider is configured; scanned documents then fail with a
   *  typed failure rather than a crash. */
  readonly model?: ModelConfiguration;
  readonly limits?: InputLimits;
  readonly retry?: RetryPolicy;
  /** Operational events. Defaults to a sink that discards, so observability is
   *  never load-bearing on an extraction. */
  readonly events?: EventSink;
}

export type ExtractionOutcome =
  | {
      readonly kind: "succeeded";
      readonly runId: string;
      readonly statementId: string;
      /** True when a previous run had already done the work. */
      readonly reused: boolean;
      readonly attempts: number;
    }
  | {
      readonly kind: "exception";
      readonly runId: string;
      readonly statementId: string;
      readonly failure: PublicFailure;
      readonly attempts: number;
    }
  | {
      readonly kind: "failed";
      readonly runId: string;
      readonly failure: PublicFailure;
      readonly attempts: number;
    }
  | {
      readonly kind: "cancelled";
      readonly runId?: string;
      readonly attempts: number;
    };

export interface RunOptions {
  readonly signal?: AbortSignal;
}

/** Thrown only to unwind an attempt; never escapes `runExtraction`. */
class AttemptFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind);
    this.name = "AttemptFailure";
  }
}

function abort(failure: Failure): never {
  throw new AttemptFailure(failure);
}

/**
 * Runs extraction for one document, retrying where the failure allows it.
 *
 * Returns an outcome rather than throwing: every failure mode here is an
 * expected state of the world, and a caller that had to catch would be back to
 * inspecting error text to decide what happened.
 */
export async function runExtraction(
  deps: ExtractionDeps,
  scope: RunScope,
  options: RunOptions = {},
): Promise<ExtractionOutcome> {
  const { db, clock } = deps;
  const policy = deps.retry ?? DEFAULT_RETRY_POLICY;
  const signal = options.signal;
  const sink = deps.events ?? NULL_SINK;
  const base: EventContext = {
    firmId: scope.firmId,
    documentId: scope.documentId,
  };

  // Idempotency, before any work: the orchestration layer's own check.
  const existing = await findSucceededRun(db, scope.firmId, scope.documentId);
  if (existing) {
    const statement = await findStatementForRun(db, scope.firmId, existing.id);
    return {
      kind: "succeeded",
      runId: existing.id,
      statementId: statement?.id ?? "",
      reused: true,
      attempts: 0,
    };
  }

  let attempts = 0;
  let lastRunId: string | undefined;
  let lastFailure: Failure | undefined;
  const startedAtMs = clock.now().getTime();

  while (attempts < policy.maxAttempts) {
    const cancelled = checkCancelled(signal);
    if (!cancelled.ok) {
      return { kind: "cancelled", ...(lastRunId ? { runId: lastRunId } : {}), attempts };
    }

    if (attempts > 0) {
      const delay = backoffDelayMs(policy, attempts + 1);
      emitEvent(
        sink,
        clock.now,
        lastRunId ? { ...base, runId: lastRunId } : base,
        EVENT_NAMES.RETRY_SCHEDULED,
        {
          failureKind: lastFailure?.kind ?? "PROCESSING_FAILED_RETRYABLE",
          attemptsMade: attempts,
          maxAttempts: policy.maxAttempts,
          delayMs: delay,
        },
      );
      try {
        await clock.sleep(delay, signal);
      } catch {
        return { kind: "cancelled", ...(lastRunId ? { runId: lastRunId } : {}), attempts };
      }
    }

    attempts += 1;
    const attemptNumber = await nextAttemptNumber(db, scope.firmId, scope.documentId);
    const runId = await createExtractionRun(db, scope, attemptNumber);
    lastRunId = runId;

    // pending -> running, validated by the machine and won at the database.
    let state: RunState = "pending";
    const claimed = transition(state, "claim");
    if (!claimed.ok) {
      return { kind: "failed", runId, failure: publicFailure(claimed.failure), attempts };
    }
    const won = await claimRun(db, scope.firmId, runId, clock.now());
    if (!won) {
      // Another caller took it. Not a failure: someone else is doing the work.
      return { kind: "cancelled", runId, attempts };
    }
    state = claimed.value;
    const runContext: EventContext = { ...base, runId };
    emitEvent(sink, clock.now, runContext, EVENT_NAMES.RUN_STARTED, {
      attempt: attemptNumber,
    });

    try {
      const result = await attempt(deps, scope, runId, signal, sink, runContext);

      if (result.reconciled) {
        const next = transition(state, "succeed");
        if (!next.ok) abort(next.failure);
        await completeExtractionRun(db, scope.firmId, runId, {
          status: "succeeded",
          inputPath: result.inputPath,
          ...(result.parserId ? { parserId: result.parserId } : {}),
          completedAt: clock.now(),
        });
        emitEvent(sink, clock.now, runContext, EVENT_NAMES.RUN_COMPLETED, {
          outcome: "succeeded",
          attempts,
          inputPath: result.inputPath === "text_layer" ? "text-layer" : "image-only",
          ...(result.parserId ? { parserId: result.parserId } : {}),
          durationMs: clock.now().getTime() - startedAtMs,
        });
        return {
          kind: "succeeded",
          runId,
          statementId: result.statementId,
          reused: false,
          attempts,
        };
      }

      const next = transition(state, "raise_exception");
      if (!next.ok) abort(next.failure);
      await completeExtractionRun(db, scope.firmId, runId, {
        status: "exception",
        inputPath: result.inputPath,
        ...(result.parserId ? { parserId: result.parserId } : {}),
        completedAt: clock.now(),
        failureKind: "RECONCILIATION_FAILED",
        failureDetail: result.reconciliationDetail,
      });
      emitEvent(sink, clock.now, runContext, EVENT_NAMES.RUN_COMPLETED, {
        outcome: "exception",
        attempts,
        inputPath: result.inputPath === "text_layer" ? "text-layer" : "image-only",
        ...(result.parserId ? { parserId: result.parserId } : {}),
        durationMs: clock.now().getTime() - startedAtMs,
      });
      return {
        kind: "exception",
        runId,
        statementId: result.statementId,
        failure: { kind: "RECONCILIATION_FAILED", detail: result.reconciliationDetail },
        attempts,
      };
    } catch (error) {
      if (!(error instanceof AttemptFailure)) throw error;
      lastFailure = error.failure;

      if (signal?.aborted) {
        // Released, not failed: nothing was carried to a conclusion.
        await releaseRun(db, scope.firmId, runId);
        emitEvent(sink, clock.now, runContext, EVENT_NAMES.RUN_COMPLETED, {
          outcome: "cancelled",
          attempts,
          durationMs: clock.now().getTime() - startedAtMs,
        });
        return { kind: "cancelled", runId, attempts };
      }

      const retrying = shouldRetry(policy, error.failure, attempts);
      const next = transition(state, "fail");
      if (!next.ok) abort(next.failure);
      await completeExtractionRun(db, scope.firmId, runId, {
        status: "failed",
        completedAt: clock.now(),
        failureKind: error.failure.kind,
        failureDetail: error.failure.detail,
      });
      if (!retrying) {
        emitEvent(sink, clock.now, runContext, EVENT_NAMES.RUN_COMPLETED, {
          outcome: "failed",
          attempts,
          durationMs: clock.now().getTime() - startedAtMs,
        });
        return { kind: "failed", runId, failure: publicFailure(error.failure), attempts };
      }
    }
  }

  return {
    kind: "failed",
    runId: lastRunId ?? "",
    failure: lastFailure
      ? publicFailure(lastFailure)
      : { kind: "PROCESSING_FAILED_PERMANENT", detail: "no attempt produced a result" },
    attempts,
  };
}

interface AttemptResult {
  readonly statementId: string;
  readonly reconciled: boolean;
  readonly reconciliationDetail: string;
  readonly inputPath: "text_layer" | "image_only";
  readonly parserId?: string;
}

/** One attempt. Every failure leaves through `abort`, carrying its taxonomy. */
async function attempt(
  deps: ExtractionDeps,
  scope: RunScope,
  runId: string,
  signal: AbortSignal | undefined,
  sink: EventSink,
  runContext: EventContext,
): Promise<AttemptResult> {
  const { db, registry, clock } = deps;

  const guard = () => {
    const c = checkCancelled(signal);
    if (!c.ok) abort(c.failure);
  };

  guard();
  const loaded = await deps.loadDocument(scope);
  if (!loaded.ok) abort(loaded.failure);

  guard();
  const extracted = await extractPdfText(scope.documentId, loaded.value, {
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  if (!extracted.ok) abort(extracted.failure);
  const document = extracted.value;

  guard();
  emitEvent(sink, clock.now, runContext, EVENT_NAMES.INPUT_SELECTED, {
    inputPath: document.kind,
    pageCount: document.pageCount,
  });

  const produced =
    document.kind === "text-layer"
      ? await viaParser(registry, document, scope, sink, clock.now, runContext)
      : await viaModel(deps, scope, runId, document, signal, sink, runContext);

  guard();
  const validated = validateStatement(produced.draft);
  if (!validated.ok) {
    emitEvent(sink, clock.now, runContext, EVENT_NAMES.VALIDATION_FAILED, {
      failureKind: validated.failure.kind,
      detail: validated.failure.detail,
    });
    abort(validated.failure);
  }

  const result = reconcile(validated.value);
  if (!result.reconciled) {
    emitEvent(sink, clock.now, runContext, EVENT_NAMES.RECONCILIATION_FAILED, {
      lineCount: result.lineCount,
      // A bucket, never the delta -- see lib/observability/events.ts.
      deltaMagnitude: deltaMagnitude(result.delta),
      runningBalanceCheck: result.runningBalances.status,
    });
  }
  const statementId = await saveStatement(db, scope, runId, validated.value, result);

  return {
    statementId,
    reconciled: result.reconciled,
    reconciliationDetail: result.reconciled
      ? "reconciled"
      : `computed closing differs from stated by ${result.delta} sen`,
    inputPath: document.kind === "text-layer" ? "text_layer" : "image_only",
    ...(produced.parserId ? { parserId: produced.parserId } : {}),
  };
}

async function viaParser(
  registry: ParserRegistry,
  document: ExtractedDocument,
  scope: RunScope,
  sink: EventSink,
  now: () => Date,
  runContext: EventContext,
) {
  const selected = registry.select(document);
  if (!selected.ok) abort(selected.failure);
  emitEvent(sink, now, runContext, EVENT_NAMES.PARSER_SELECTED, {
    parserId: selected.value.id,
    candidateCount: registry.parsers.length,
  });
  const parsed = await selected.value.parse(document, {
    documentId: scope.documentId,
  });
  if (!parsed.ok) abort(parsed.failure);
  return { draft: parsed.value, parserId: selected.value.id };
}

async function viaModel(
  deps: ExtractionDeps,
  scope: RunScope,
  runId: string,
  document: ExtractedDocument,
  signal: AbortSignal | undefined,
  sink: EventSink,
  runContext: EventContext,
) {
  if (!deps.model) {
    abort({
      kind: "MISSING_TEXT_LAYER",
      detail:
        "the document has no text layer and no model provider is configured for the scanned path",
    });
  }

  emitEvent(sink, deps.clock.now, runContext, EVENT_NAMES.MODEL_CALL_STARTED, {
    provider: deps.model.deps.adapter.provider,
    model: deps.model.deps.adapter.model,
    maxOutputTokens: deps.model.maxOutputTokens,
  });

  const { record, draft } = await meteredInvoke(
    deps.model.deps,
    {
      documentId: scope.documentId,
      instructions: deps.model.instructions,
      pages: [],
      maxOutputTokens: deps.model.maxOutputTokens,
    },
    { documentId: scope.documentId, pageCount: document.pageCount },
    // Cancellation reaches the provider's own transport, so an abandoned
    // request does not leave work running and billing on the far side.
    signal ? { signal } : {},
  );

  await saveProviderCall(
    deps.db,
    scope.firmId,
    runId,
    record,
    deps.model.deps.adapter.pricingMode,
  );

  if (record.failure?.kind === "COST_CEILING_EXCEEDED") {
    // Our own spend, not client data: the number is the whole point.
    emitEvent(sink, deps.clock.now, runContext, EVENT_NAMES.COST_REJECTED, {
      provider: record.provider,
      model: record.model,
      estimatedMaxCostMicrocents: String(record.estimatedMaximumCost ?? 0n),
      ceilingMicrocents: String(deps.model.deps.ceiling.perCallMicrocents),
      rateTableVersion: record.rateTableVersion,
    });
  }

  emitEvent(sink, deps.clock.now, runContext, EVENT_NAMES.MODEL_CALL_COMPLETED, {
    provider: record.provider,
    model: record.model,
    outcome: record.outcome,
    ...(record.usage
      ? {
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          cacheCreationTokens: record.usage.cacheCreationTokens,
          cacheReadTokens: record.usage.cacheReadTokens,
        }
      : {}),
    ...(record.actualCost === undefined
      ? {}
      : { actualCostMicrocents: String(record.actualCost) }),
    ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
  });

  if (!draft) {
    abort({
      kind: record.failure?.kind ?? "PROVIDER_FAILED",
      detail: record.failure?.detail ?? "the provider produced no statement",
    });
  }
  return { draft, parserId: undefined };
}
