/**
 * The typed failure taxonomy for extraction, reconciliation and cost control.
 *
 * Every fallible operation in M2 returns a `Result` carrying one of these rather
 * than throwing a string or an `Error`. Three reasons, in order of importance:
 *
 *   1. A caller can branch on `kind` exhaustively. `noFallthroughCasesInSwitch`
 *      plus a union means adding a failure kind breaks compilation at every site
 *      that must handle it -- which is the point.
 *   2. Retryability is a property of the failure, decided once here, rather than
 *      re-derived by each caller from a message it pattern-matches.
 *   3. `cause` stays attached without ever being formatted into user-facing
 *      text. A stack trace or a provider payload may quote document content; a
 *      `detail` never does.
 *
 * This mirrors the Result-shaped returns already used in `lib/upload/validation`
 * and `lib/authz/operations` rather than introducing a second convention.
 */

/**
 * What went wrong. Deliberately coarse: a kind exists when some caller would
 * genuinely act differently, not to describe every way a step can fail.
 */
export type FailureKind =
  /** The bytes are not a type this pipeline handles at all. */
  | "UNSUPPORTED_INPUT"
  /** The container parsed as its declared type and is internally broken. */
  | "CORRUPT_DOCUMENT"
  /** A PDF with no usable text layer. A routing signal, not a defect: it means
   *  the scanned path applies. */
  | "MISSING_TEXT_LAYER"
  /** A page could not be rasterised. */
  | "RENDERING_FAILED"
  /** A date string admits more than one reading and nothing may choose for it. */
  | "AMBIGUOUS_DATE"
  /** A monetary token could not be read without guessing or rounding. */
  | "INVALID_MONETARY_VALUE"
  /** Extraction output was structurally or semantically unusable. */
  | "EXTRACTION_VALIDATION_FAILED"
  /** The arithmetic gate rejected the statement. An exception, not a bug. */
  | "RECONCILIATION_FAILED"
  /** A model call would have breached the configured ceiling. */
  | "COST_CEILING_EXCEEDED"
  /** The model provider failed. Transient by default; the adapter narrows it. */
  | "PROVIDER_FAILED"
  /** Orchestration-level: worth another attempt. */
  | "PROCESSING_FAILED_RETRYABLE"
  /** Orchestration-level: another attempt would fail identically. */
  | "PROCESSING_FAILED_PERMANENT";

/**
 * Kinds a further attempt could plausibly resolve.
 *
 * `COST_CEILING_EXCEEDED` is deliberately NOT retryable. Retrying a call that
 * was refused for budget reasons spends the budget it was refused to protect;
 * the ceiling has to move first, and that is a human decision.
 *
 * `RECONCILIATION_FAILED` is not retryable either -- the same bytes reconcile
 * the same way. It is an exception awaiting a person, which is what
 * `CLAUDE.md` non-negotiable 3 requires.
 *
 * `RENDERING_FAILED` is treated as permanent because rendering is deterministic
 * given the same bytes. A genuinely transient cause (memory pressure, say) is
 * the orchestrator's to reclassify by wrapping it in
 * `PROCESSING_FAILED_RETRYABLE` -- the default must not be "try again forever".
 */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "PROVIDER_FAILED",
  "PROCESSING_FAILED_RETRYABLE",
]);

/**
 * Upper bound on `detail`. Not a security control on its own -- the rule below
 * is -- but it stops an accidental dump of a page of extracted text from
 * reaching a log through a failure object.
 */
export const MAX_DETAIL_LENGTH = 200;

export interface Failure {
  readonly kind: FailureKind;
  /**
   * A bounded, safe description of what was wrong.
   *
   * **Never document content and never a secret.** The distinction this codebase
   * draws: a *date token* may appear here, because a date is provenance and the
   * report is useless without it; a *monetary value* may not, because an amount
   * is the financial content itself. Money failures therefore say what was
   * malformed ("more than two decimal places") rather than echoing the input.
   * `lib/domain/money.test.ts` asserts this.
   */
  readonly detail: string;
  /**
   * The original cause, retained for operators. Never crosses a trust boundary:
   * `publicFailure` drops it, and nothing formats it into `detail`.
   */
  readonly cause?: unknown;
}

/** What a caller outside the server may see. */
export type PublicFailure = Pick<Failure, "kind" | "detail">;

export function failure(
  kind: FailureKind,
  detail: string,
  cause?: unknown,
): Failure {
  const trimmed =
    detail.length > MAX_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
      : detail;
  return cause === undefined
    ? { kind, detail: trimmed }
    : { kind, detail: trimmed, cause };
}

export function isRetryable(f: Failure): boolean {
  return RETRYABLE.has(f.kind);
}

/** Strips `cause`. The only shape that may leave the server. */
export function publicFailure(f: Failure): PublicFailure {
  return { kind: f.kind, detail: f.detail };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(f: Failure): Result<T> {
  return { ok: false, failure: f };
}

/** `err` for the common case of building the failure inline. */
export function fail<T = never>(
  kind: FailureKind,
  detail: string,
  cause?: unknown,
): Result<T> {
  return err<T>(failure(kind, detail, cause));
}

/**
 * Collects a list of results, failing on the first failure.
 *
 * Deliberately fail-fast rather than accumulating: a statement with an
 * unreadable amount is not partially usable, and returning "here are the lines
 * that worked" is exactly how a wrong total reaches an accountant.
 */
export function allOk<T>(results: readonly Result<T>[]): Result<T[]> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return err<T[]>(r.failure);
    values.push(r.value);
  }
  return ok(values);
}
