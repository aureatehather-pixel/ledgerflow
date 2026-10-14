/**
 * Retry policy.
 *
 * **Retryability is a property of the failure, never of its text.** It was
 * decided once, in `lib/domain/failures.ts`, and this module only reads
 * `isRetryable`. Nothing here inspects a message, an exception class or a status
 * code — a caller that matched on error text would silently stop retrying the
 * day a provider reworded something.
 *
 * Two consequences worth stating, both inherited rather than re-decided here:
 * a cost-ceiling breach is never retried, because retrying spends the budget it
 * was refused to protect; and a failed reconciliation is never retried, because
 * the same bytes reconcile the same way and it is an exception awaiting a
 * person.
 */

import { isRetryable, type Failure } from "@/lib/domain/failures";

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

/**
 * Exponential backoff, capped. `attempt` is 1-based.
 *
 * **No jitter, deliberately.** Jitter exists to stop a fleet of workers
 * retrying in lockstep; there is one in-process caller today, so it would add
 * nondeterminism to the test suite and solve nothing.
 * · *reconsider when:* more than one worker can process the same queue —
 * exactly when a queue-backed deployment arrives.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  if (attempt <= 1) return 0;
  const exponential = policy.baseDelayMs * 2 ** (attempt - 2);
  return Math.min(exponential, policy.maxDelayMs);
}

/**
 * Whether another attempt should be made.
 *
 * Both conditions matter: the failure has to be the kind that could succeed on
 * a retry, *and* there has to be an attempt left.
 */
export function shouldRetry(
  policy: RetryPolicy,
  failure: Failure,
  attemptsMade: number,
): boolean {
  return isRetryable(failure) && attemptsMade < policy.maxAttempts;
}
