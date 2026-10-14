/**
 * Validation of untrusted provider output.
 *
 * Two rules govern this file.
 *
 * **A provider reporting success has proved nothing.** Structured-output modes
 * constrain generation; they are not a guarantee, and a malformed response that
 * still bills is a real outcome. Everything crossing this boundary is validated
 * before it becomes a value.
 *
 * **These schemas are not the domain model.** They describe what a provider
 * emits — strings, because a model returns text. The transform below turns them
 * into domain values through `parseAmount` and `parseStatementDate`, which is
 * where malformed money and ambiguous dates are caught by machinery that already
 * exists. If the provider's shape were used directly as the domain, every
 * consumer would inherit the provider's assumptions.
 *
 * **Errors never echo the payload.** Zod issue *messages* can quote received
 * values; only `path` and `code` are reported, capped at five issues, and
 * `failure()` bounds the result again.
 */

import { z } from "zod";

import { parseStatementDate } from "@/lib/domain/dates";
import { fail, ok, type Result } from "@/lib/domain/failures";
import { parseMagnitude, sen, type Sen } from "@/lib/domain/money";
import type { StatementDraft, StatementLine } from "@/lib/domain/statement";

import type { ModelRequest, ProviderUsage } from "./adapter";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
  })
  .strict();

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .join("; ");
}

/**
 * Validates reported usage, structurally and against the request.
 *
 * The relational check matters as much as the shape one: a provider claiming
 * more output tokens than the request permitted contradicts the request itself,
 * and billing it would mean paying for tokens the cap forbade.
 */
export function validateUsage(
  raw: unknown,
  request: ModelRequest,
): Result<ProviderUsage> {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      `provider usage is malformed (${describeIssues(parsed.error)})`,
    );
  }
  const usage = parsed.data;

  if (usage.outputTokens > request.maxOutputTokens) {
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      `provider reported ${usage.outputTokens} output tokens above the requested cap of ${request.maxOutputTokens}`,
    );
  }

  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationTokens +
    usage.cacheReadTokens;
  if (total === 0) {
    // A successful call that billed nothing at all is not plausible; it means
    // usage was dropped somewhere, and a zero here would understate the ledger.
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      "provider reported zero tokens across every billable class",
    );
  }

  return ok(usage);
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * What a provider is asked to emit.
 *
 * Amounts and dates are strings because that is what a model produces. Parsing
 * them here rather than accepting numbers is deliberate: a JSON number for money
 * would already be a float by the time it arrived, and the whole point of
 * `lib/domain/money` is that a balance never touches one.
 *
 * `debit` and `credit` are magnitudes, empty when the column was blank —
 * matching a statement, where direction is positional.
 */
const lineSchema = z
  .object({
    date: z.string().min(1),
    description: z.string().min(1),
    debit: z.string(),
    credit: z.string(),
    runningBalance: z.string().optional(),
    page: z.number().int().positive(),
  })
  .strict();

const statementSchema = z
  .object({
    accountReference: z.string().min(1),
    currency: z.string().length(3),
    periodStart: z.string().min(1),
    periodEnd: z.string().min(1),
    openingBalance: z.string().min(1),
    closingBalance: z.string().min(1),
    lines: z.array(lineSchema),
  })
  .strict();

/** The provider-facing shape, exported for the fake and for tests only. */
export type RawStatementOutput = z.infer<typeof statementSchema>;

export interface TransformContext {
  readonly documentId: string;
  readonly pageCount: number;
  /**
   * Date convention to apply where a token is otherwise ambiguous. Left unset
   * in M2a: without a corpus nothing may choose, so an ambiguous date fails.
   */
  readonly assumeDateConvention?: "DMY" | "MDY";
}

function amountOrZero(raw: string, label: string): Result<Sen> {
  if (raw.trim().length === 0) return ok(sen(0n));
  const parsed = parseMagnitude(raw);
  if (!parsed.ok) {
    // The money parser already refuses to echo the value; the label says which
    // field, never what was in it.
    return fail("EXTRACTION_VALIDATION_FAILED", `${label}: ${parsed.failure.detail}`);
  }
  return parsed;
}

/**
 * Validates and converts provider output into a `StatementDraft`.
 *
 * A draft, never a `Statement` — structural validation and the reconciliation
 * gate still apply afterwards. A model cannot certify its own output.
 */
export function toStatementDraft(
  raw: unknown,
  context: TransformContext,
): Result<StatementDraft> {
  const parsed = statementSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "EXTRACTION_VALIDATION_FAILED",
      `provider output is malformed (${describeIssues(parsed.error)})`,
    );
  }
  const value = parsed.data;

  const dateOptions =
    context.assumeDateConvention === undefined
      ? {}
      : { assume: context.assumeDateConvention };

  const periodStart = parseStatementDate(value.periodStart, dateOptions);
  if (!periodStart.ok) return periodStart;
  const periodEnd = parseStatementDate(value.periodEnd, dateOptions);
  if (!periodEnd.ok) return periodEnd;

  const opening = amountOrZero(value.openingBalance, "openingBalance");
  if (!opening.ok) return opening;
  const closing = amountOrZero(value.closingBalance, "closingBalance");
  if (!closing.ok) return closing;

  const lines: StatementLine[] = [];
  for (let i = 0; i < value.lines.length; i += 1) {
    const line = value.lines[i];
    if (line === undefined) continue;
    const at = `line ${i + 1}`;

    const date = parseStatementDate(line.date, dateOptions);
    if (!date.ok) {
      return fail(
        "EXTRACTION_VALIDATION_FAILED",
        `${at}: ${date.failure.detail}`,
      );
    }
    const debit = amountOrZero(line.debit, `${at} debit`);
    if (!debit.ok) return debit;
    const credit = amountOrZero(line.credit, `${at} credit`);
    if (!credit.ok) return credit;

    let runningBalance: Sen | undefined;
    if (line.runningBalance !== undefined && line.runningBalance.trim() !== "") {
      const parsedBalance = parseMagnitude(line.runningBalance);
      if (!parsedBalance.ok) {
        return fail(
          "EXTRACTION_VALIDATION_FAILED",
          `${at} runningBalance: ${parsedBalance.failure.detail}`,
        );
      }
      runningBalance = parsedBalance.value;
    }

    lines.push({
      date: date.value.value,
      dateRaw: date.value.raw,
      description: line.description,
      debit: debit.value,
      credit: credit.value,
      source: { documentId: context.documentId, page: line.page },
      ...(runningBalance === undefined ? {} : { runningBalance }),
    });
  }

  return ok<StatementDraft>({
    accountReference: value.accountReference,
    currency: value.currency,
    periodStart: periodStart.value.value,
    periodEnd: periodEnd.value.value,
    openingBalance: opening.value,
    closingBalance: closing.value,
    lines,
    source: { documentId: context.documentId, pageCount: context.pageCount },
  });
}
