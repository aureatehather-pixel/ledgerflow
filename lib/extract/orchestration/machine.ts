/**
 * The extraction-run state machine.
 *
 * One table, exhaustively defined, is the only place a run's lifecycle is
 * described. Orchestration code asks this module whether a move is legal rather
 * than comparing status strings at each site — which is how a fifth status
 * quietly appears in one branch and not another.
 *
 * **Total.** Every (state, event) pair has an entry; `null` means "not legal
 * here" and is a decision rather than an omission. A test walks the full
 * cartesian product, so adding a state or an event fails compilation *and* the
 * suite until every combination has been considered.
 *
 * **Deterministic.** `transition` is pure. No clock, no database, no randomness.
 *
 * **Retries do not resurrect a run.** There is deliberately no edge back out of
 * `failed`. A retry inserts a *new* run at the next attempt number, so the
 * history of what was tried survives — the schema's
 * `(firm_id, document_id, attempt)` uniqueness exists for exactly this.
 */

import { fail, ok, type Result } from "@/lib/domain/failures";

/** Mirrors the `extraction_run_status` enum in migration 0005. */
export type RunState = "pending" | "running" | "succeeded" | "exception" | "failed";

/**
 * What can happen to a run.
 *
 *   claim            a worker took it
 *   succeed          a statement was extracted, validated and reconciled
 *   raise_exception  extracted and structurally valid, arithmetic gate refused
 *   fail             processing could not produce a statement
 *   release          the worker gave it up -- cancelled, abandoned, or its
 *                    lease expired -- and it must become claimable again
 */
export type RunEvent =
  | "claim"
  | "succeed"
  | "raise_exception"
  | "fail"
  | "release";

export const RUN_STATES: readonly RunState[] = [
  "pending",
  "running",
  "succeeded",
  "exception",
  "failed",
];

export const RUN_EVENTS: readonly RunEvent[] = [
  "claim",
  "succeed",
  "raise_exception",
  "fail",
  "release",
];

/**
 * The whole lifecycle. `null` is an explicit refusal, not a gap.
 *
 * `pending -> fail` exists because a run can be rejected before any worker
 * claims it — an unreadable document, or a cost ceiling that refuses the call.
 * `running -> release` is cancellation: back to claimable, never stuck.
 */
const TRANSITIONS: Readonly<
  Record<RunState, Readonly<Record<RunEvent, RunState | null>>>
> = Object.freeze({
  pending: Object.freeze({
    claim: "running",
    succeed: null,
    raise_exception: null,
    fail: "failed",
    release: null,
  }),
  running: Object.freeze({
    claim: null,
    succeed: "succeeded",
    raise_exception: "exception",
    fail: "failed",
    release: "pending",
  }),
  // Terminal. A retry is a new run at the next attempt, not a revival.
  succeeded: Object.freeze({
    claim: null,
    succeed: null,
    raise_exception: null,
    fail: null,
    release: null,
  }),
  exception: Object.freeze({
    claim: null,
    succeed: null,
    raise_exception: null,
    fail: null,
    release: null,
  }),
  failed: Object.freeze({
    claim: null,
    succeed: null,
    raise_exception: null,
    fail: null,
    release: null,
  }),
});

export function isTerminal(state: RunState): boolean {
  return RUN_EVENTS.every((event) => TRANSITIONS[state][event] === null);
}

/** The legal next state, or a typed failure. Never throws, never guesses. */
export function transition(
  from: RunState,
  event: RunEvent,
): Result<RunState> {
  const next = TRANSITIONS[from][event];
  if (next === null) {
    return fail(
      "PROCESSING_FAILED_PERMANENT",
      `illegal transition: cannot ${event} a run that is ${from}`,
    );
  }
  return ok(next);
}

/** Whether a move is legal, without producing a failure object. */
export function canTransition(from: RunState, event: RunEvent): boolean {
  return TRANSITIONS[from][event] !== null;
}

/** Events legal from a state. Exists so a caller never enumerates by hand. */
export function legalEvents(from: RunState): readonly RunEvent[] {
  return RUN_EVENTS.filter((event) => TRANSITIONS[from][event] !== null);
}
