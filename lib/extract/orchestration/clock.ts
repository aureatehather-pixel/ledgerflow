/**
 * Time and waiting, injected.
 *
 * Nothing in orchestration calls `Date.now()` or `setTimeout` directly. Backoff,
 * lease expiry and any future scheduling are therefore deterministic under test:
 * a test advances a clock rather than sleeping, so a retry sequence that would
 * take half a minute in production is verified in microseconds and always the
 * same way.
 *
 * `sleep` takes the cancellation signal because a waiting worker is the easiest
 * place to leak one: abandoning a request while a backoff is pending must not
 * hold the process for the remainder of the delay.
 */

import { fail, ok, type Result } from "@/lib/domain/failures";

export interface Clock {
  now(): Date;
  /** Resolves after `ms`, or rejects promptly if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export function systemClock(): Clock {
  return {
    now: () => new Date(),
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(new CancelledError());
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new CancelledError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export interface TestClock extends Clock {
  /** Moves time forward and resolves every sleep that has come due. */
  advance(ms: number): Promise<void>;
  /** Sleeps currently waiting. Lets a test assert a worker is backing off. */
  pending(): number;
}

/**
 * A clock a test drives.
 *
 * Sleeps do not resolve until `advance` passes their deadline, so a test can
 * assert that a retry has *not* happened yet — which a real timer cannot do
 * without making the suite slow and flaky.
 */
export function testClock(startIso = "2026-07-30T00:00:00.000Z"): TestClock {
  let current = new Date(startIso).getTime();
  const waiters: {
    due: number;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];

  return {
    now: () => new Date(current),

    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(new CancelledError());
      // A deadline that has already passed is due now. Queuing it would make a
      // zero-delay backoff wait for an `advance` that a caller has no reason to
      // make, which is a hang rather than a delay.
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { due: current + ms, resolve, reject };
        waiters.push(waiter);
        signal?.addEventListener(
          "abort",
          () => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(new CancelledError());
          },
          { once: true },
        );
      });
    },

    async advance(ms) {
      current += ms;
      const due = waiters.filter((w) => w.due <= current);
      for (const waiter of due) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      // Let resolved continuations run before the caller asserts.
      await Promise.resolve();
    },

    pending: () => waiters.length,
  };
}

/** Converts an abort into the taxonomy, so cancellation is a value not a throw. */
export function checkCancelled<T = never>(
  signal: AbortSignal | undefined,
): Result<T | null> {
  if (signal?.aborted) {
    return fail<T | null>(
      "PROCESSING_FAILED_RETRYABLE",
      "the request was cancelled before this step",
    );
  }
  return ok(null);
}
