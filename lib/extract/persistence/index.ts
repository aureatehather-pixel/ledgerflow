/**
 * Reading and writing extraction results.
 *
 * **Every query is tenant-scoped by argument, not by convention.** No function
 * here accepts a bare id: each takes the firm as a separate, required parameter
 * and puts it in the `WHERE` clause, the same discipline `lib/authz` uses. A
 * caller cannot fetch a statement by id alone, so there is no shape a
 * cross-tenant read can take.
 *
 * The database enforces the same thing underneath through composite foreign
 * keys including `firm_id` (migration 0005), so a write that named the wrong
 * firm would be rejected rather than merely unfiltered.
 *
 * Money crosses this boundary only through `codec.ts`.
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { microcentsToDbNullable, microcentsFromDbNullable } from "./codec";
import {
  isoDateFromDb,
  isoDateToDb,
  senFromDb,
  senFromDbNullable,
  senToDb,
  senToDbNullable,
} from "./codec";
import type { ModelCallRecord } from "../model/invoke";
import type { ReconciliationResult } from "@/lib/reconcile";
import type { Statement, StatementDraft } from "@/lib/domain/statement";
import { uuidv7 } from "@/lib/db/ids";
import {
  extractionRuns,
  providerCalls,
  statementLines,
  statements,
} from "@/lib/db/schema";

/** Minimal Drizzle surface, matching the convention in `lib/authz`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Tenant plus the document being processed. Required by every operation. */
export interface RunScope {
  readonly firmId: string;
  readonly clientId: string;
  readonly documentId: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "exception"
  | "failed";

export type InputPath = "unknown" | "text_layer" | "image_only";

export async function createExtractionRun(
  db: Db,
  scope: RunScope,
  attempt = 1,
): Promise<string> {
  const id = uuidv7();
  await db.insert(extractionRuns).values({
    id,
    firmId: scope.firmId,
    clientId: scope.clientId,
    documentId: scope.documentId,
    attempt,
  });
  return id;
}

export interface RunCompletion {
  readonly status: RunStatus;
  readonly inputPath?: InputPath;
  readonly parserId?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly failureKind?: string;
  readonly failureDetail?: string;
}

/** Tenant-scoped by construction: `firmId` is part of the WHERE clause. */
export async function completeExtractionRun(
  db: Db,
  firmId: string,
  runId: string,
  completion: RunCompletion,
): Promise<void> {
  await db
    .update(extractionRuns)
    .set({
      status: completion.status,
      ...(completion.inputPath ? { inputPath: completion.inputPath } : {}),
      ...(completion.parserId ? { parserId: completion.parserId } : {}),
      ...(completion.startedAt ? { startedAt: completion.startedAt } : {}),
      ...(completion.completedAt ? { completedAt: completion.completedAt } : {}),
      ...(completion.failureKind ? { failureKind: completion.failureKind } : {}),
      ...(completion.failureDetail
        ? { failureDetail: completion.failureDetail }
        : {}),
    })
    .where(
      and(eq(extractionRuns.id, runId), eq(extractionRuns.firmId, firmId)),
    );
}

/**
 * Atomically takes a pending run.
 *
 * The `status = 'pending'` predicate is the coordination primitive: two workers
 * issuing this concurrently cannot both match, because the first UPDATE holds
 * the row until it commits and the second then sees `running`. Returns whether
 * this caller won.
 *
 * Orchestration owns idempotency; this is how it asserts it. The unique index
 * on succeeded runs remains the final net beneath both.
 */
export async function claimRun(
  db: Db,
  firmId: string,
  runId: string,
  startedAt: Date,
): Promise<boolean> {
  const updated = await db
    .update(extractionRuns)
    .set({ status: "running", startedAt })
    .where(
      and(
        eq(extractionRuns.id, runId),
        eq(extractionRuns.firmId, firmId),
        eq(extractionRuns.status, "pending"),
      ),
    )
    .returning({ id: extractionRuns.id });
  return updated.length === 1;
}

/**
 * Returns a claimed run to the pool.
 *
 * Cancellation and abandonment land here rather than in `failed`: the work was
 * never attempted to completion, so recording a failure would misreport it. A
 * `pending` run is visible and claimable, which is what a queue-backed worker
 * would want; an in-process caller with no worker simply leaves it queryable.
 */
export async function releaseRun(
  db: Db,
  firmId: string,
  runId: string,
): Promise<void> {
  await db
    .update(extractionRuns)
    .set({ status: "pending", startedAt: null })
    .where(
      and(
        eq(extractionRuns.id, runId),
        eq(extractionRuns.firmId, firmId),
        eq(extractionRuns.status, "running"),
      ),
    );
}

/** The already-succeeded run for a document, if there is one. Tenant-scoped. */
export async function findSucceededRun(
  db: Db,
  firmId: string,
  documentId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: extractionRuns.id })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.firmId, firmId),
        eq(extractionRuns.documentId, documentId),
        eq(extractionRuns.status, "succeeded"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Next attempt number for a document. 1 when nothing has been tried. */
export async function nextAttemptNumber(
  db: Db,
  firmId: string,
  documentId: string,
): Promise<number> {
  const rows = await db
    .select({ attempt: extractionRuns.attempt })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.firmId, firmId),
        eq(extractionRuns.documentId, documentId),
      ),
    )
    .orderBy(desc(extractionRuns.attempt))
    .limit(1);
  const highest = rows[0]?.attempt;
  return typeof highest === "number" ? highest + 1 : 1;
}

/** The statement recorded for a run, if any. Tenant-scoped. */
export async function findStatementForRun(
  db: Db,
  firmId: string,
  runId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: statements.id })
    .from(statements)
    .where(and(eq(statements.firmId, firmId), eq(statements.runId, runId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Persists a statement and its lines.
 *
 * Takes the reconciliation result rather than recomputing it: the arithmetic
 * belongs to `lib/reconcile`, and a second implementation here could disagree
 * with the gate that already ran.
 *
 * One transaction, because a statement without its lines reconciles to a
 * different number than the one recorded on it.
 */
export async function saveStatement(
  db: Db,
  scope: RunScope,
  runId: string,
  statement: Statement | StatementDraft,
  reconciliation: ReconciliationResult,
): Promise<string> {
  const statementId = uuidv7();

  await db.transaction(async (tx: Db) => {
    await tx.insert(statements).values({
      id: statementId,
      firmId: scope.firmId,
      runId,
      documentId: scope.documentId,
      accountReference: statement.accountReference,
      currency: statement.currency,
      periodStart: isoDateToDb(statement.periodStart),
      periodEnd: isoDateToDb(statement.periodEnd),
      openingBalanceSen: senToDb(statement.openingBalance),
      closingBalanceSen: senToDb(statement.closingBalance),
      pageCount: statement.source.pageCount,
      reconciled: reconciliation.reconciled,
      computedClosingSen: senToDb(reconciliation.computedClosing),
      deltaSen: senToDb(reconciliation.delta),
    });

    if (statement.lines.length > 0) {
      await tx.insert(statementLines).values(
        statement.lines.map((line, index) => ({
          id: uuidv7(),
          firmId: scope.firmId,
          statementId,
          lineIndex: index,
          transactionDate: isoDateToDb(line.date),
          dateRaw: line.dateRaw,
          description: line.description,
          debitSen: senToDb(line.debit),
          creditSen: senToDb(line.credit),
          runningBalanceSen: senToDbNullable(line.runningBalance),
          sourcePage: line.source.page,
          sourceLocator: line.source.locator ?? null,
        })),
      );
    }
  });

  return statementId;
}

export interface LoadedStatement {
  readonly id: string;
  readonly draft: StatementDraft;
  readonly reconciled: boolean;
  readonly deltaSen: bigint;
}

/**
 * Loads a statement and its lines.
 *
 * `firmId` is required and applied to both queries. There is deliberately no
 * `findStatementById` — a function that could be called without a tenant is a
 * function that eventually is.
 */
export async function loadStatement(
  db: Db,
  firmId: string,
  statementId: string,
): Promise<LoadedStatement | null> {
  const rows = await db
    .select()
    .from(statements)
    .where(and(eq(statements.id, statementId), eq(statements.firmId, firmId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const lineRows = await db
    .select()
    .from(statementLines)
    .where(
      and(
        eq(statementLines.statementId, statementId),
        eq(statementLines.firmId, firmId),
      ),
    )
    .orderBy(asc(statementLines.lineIndex));

  return {
    id: row.id,
    reconciled: row.reconciled,
    deltaSen: senFromDb(row.deltaSen),
    draft: {
      accountReference: row.accountReference,
      currency: row.currency,
      periodStart: isoDateFromDb(row.periodStart),
      periodEnd: isoDateFromDb(row.periodEnd),
      openingBalance: senFromDb(row.openingBalanceSen),
      closingBalance: senFromDb(row.closingBalanceSen),
      source: { documentId: row.documentId, pageCount: row.pageCount },
      lines: lineRows.map((line: Record<string, unknown>) => {
        const running = senFromDbNullable(line["runningBalanceSen"]);
        const locator = line["sourceLocator"];
        return {
          date: isoDateFromDb(line["transactionDate"]),
          dateRaw: String(line["dateRaw"]),
          description: String(line["description"]),
          debit: senFromDb(line["debitSen"]),
          credit: senFromDb(line["creditSen"]),
          source: {
            documentId: row.documentId,
            page: Number(line["sourcePage"]),
            ...(typeof locator === "string" ? { locator } : {}),
          },
          ...(running === undefined ? {} : { runningBalance: running }),
        };
      }),
    },
  };
}

/**
 * Records one provider call.
 *
 * Takes a `ModelCallRecord`, which by construction carries counts, costs,
 * identifiers and an outcome — and no prompt, response or transaction text.
 * Nothing here can widen that: there is no column to widen it into.
 */
export async function saveProviderCall(
  db: Db,
  firmId: string,
  runId: string,
  record: ModelCallRecord,
  pricingMode: {
    platform: string;
    inference: string;
    routing: string;
    cacheWriteTtl: string;
  },
  rateEffectiveFrom?: string,
): Promise<string> {
  const id = uuidv7();
  await db.insert(providerCalls).values({
    id,
    firmId,
    runId,
    provider: record.provider,
    model: record.model,
    pricingPlatform: pricingMode.platform,
    pricingInference: pricingMode.inference,
    pricingRouting: pricingMode.routing,
    pricingCacheWriteTtl: pricingMode.cacheWriteTtl,
    rateTableVersion: record.rateTableVersion,
    rateEffectiveFrom: rateEffectiveFrom ?? null,
    requestId: record.requestId ?? null,
    inputTokens: record.usage?.inputTokens ?? null,
    outputTokens: record.usage?.outputTokens ?? null,
    cacheCreationTokens: record.usage?.cacheCreationTokens ?? null,
    cacheReadTokens: record.usage?.cacheReadTokens ?? null,
    currency: record.currency,
    estimatedMaxCostMicrocents: microcentsToDbNullable(
      record.estimatedMaximumCost,
    ),
    actualCostMicrocents: microcentsToDbNullable(record.actualCost),
    startedAt: new Date(record.startedAt),
    completedAt: new Date(record.completedAt),
    outcome: record.outcome.replace(/-/g, "_"),
    failureKind: record.failure?.kind ?? null,
    failureDetail: record.failure?.detail ?? null,
  });
  return id;
}

export async function loadProviderCalls(
  db: Db,
  firmId: string,
  runId: string,
): Promise<
  { id: string; actualCost?: bigint; estimatedMaximumCost?: bigint; outcome: string }[]
> {
  const rows = await db
    .select()
    .from(providerCalls)
    .where(and(eq(providerCalls.firmId, firmId), eq(providerCalls.runId, runId)))
    .orderBy(asc(providerCalls.startedAt));

  return rows.map((row: Record<string, unknown>) => {
    const actual = microcentsFromDbNullable(row["actualCostMicrocents"]);
    const estimated = microcentsFromDbNullable(row["estimatedMaxCostMicrocents"]);
    return {
      id: String(row["id"]),
      outcome: String(row["outcome"]),
      ...(actual === undefined ? {} : { actualCost: actual }),
      ...(estimated === undefined ? {} : { estimatedMaximumCost: estimated }),
    };
  });
}
