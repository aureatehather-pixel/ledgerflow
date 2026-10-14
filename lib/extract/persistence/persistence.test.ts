import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { microcents } from "@/lib/cost/rates";
import { uuidv7 } from "@/lib/db/ids";
import { createTestDatabase } from "@/lib/db/testing";
import { sen } from "@/lib/domain/money";
import { validateStatement } from "@/lib/domain/statement";
import { buildStatementDraft, corruptLineAmount } from "@/lib/domain/testing";
import { reconcile } from "@/lib/reconcile";

import type { ModelCallRecord } from "../model/invoke";
import {
  isoDateFromDb,
  microcentsFromDb,
  senFromDb,
  senFromDbNullable,
} from "./codec";
import {
  completeExtractionRun,
  createExtractionRun,
  loadProviderCalls,
  loadStatement,
  saveProviderCall,
  saveStatement,
  type RunScope,
} from "./index";

/** One PGlite instance for the whole file: each is a full Postgres in WASM, and
 *  vitest already runs files sequentially because of the memory cost. */
let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let scopeA: RunScope;
let scopeB: RunScope;

const MODE = {
  platform: "anthropic-first-party",
  inference: "standard",
  routing: "global",
  cacheWriteTtl: "5m",
};

async function seedTenant(db: unknown, name: string): Promise<RunScope> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = db as any;
  const firmId = uuidv7();
  const clientId = uuidv7();
  const userId = uuidv7();
  const documentId = uuidv7();

  await d.execute(sql`insert into firms (id, name) values (${firmId}, ${name})`);
  await d.execute(
    sql`insert into users (id, firm_id, email, name, firm_role)
        values (${userId}, ${firmId}, ${`u-${userId}@example.test`}, 'U', 'staff')`,
  );
  await d.execute(
    sql`insert into clients (id, firm_id, name, code)
        values (${clientId}, ${firmId}, ${`C ${name}`}, ${`C-${name}`})`,
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
  scopeA = await seedTenant(harness.db, "Alpha");
  scopeB = await seedTenant(harness.db, "Beta");
});

afterEach(async () => {
  await harness.close();
});

function balanced(overrides = {}) {
  const draft = buildStatementDraft({ documentId: scopeA.documentId, lineCount: 6, ...overrides });
  const validated = validateStatement(draft);
  if (!validated.ok) throw new Error(validated.failure.detail);
  return validated.value;
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("statement round trip", () => {
  it("stores and reloads every field", async () => {
    const statement = balanced({ withRunningBalances: true });
    const runId = await createExtractionRun(harness.db, scopeA);
    const statementId = await saveStatement(
      harness.db,
      scopeA,
      runId,
      statement,
      reconcile(statement),
    );

    const loaded = await loadStatement(harness.db, scopeA.firmId, statementId);
    expect(loaded).not.toBeNull();
    expect(loaded!.draft.accountReference).toBe(statement.accountReference);
    expect(loaded!.draft.currency).toBe(statement.currency);
    expect(loaded!.draft.periodStart).toBe(statement.periodStart);
    expect(loaded!.draft.openingBalance).toBe(statement.openingBalance);
    expect(loaded!.draft.closingBalance).toBe(statement.closingBalance);
    expect(loaded!.draft.lines).toHaveLength(statement.lines.length);
    expect(loaded!.reconciled).toBe(true);
    expect(loaded!.deltaSen).toBe(0n);
  });

  it("reloads a statement that still validates and reconciles", async () => {
    const statement = balanced();
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    const loaded = await loadStatement(harness.db, scopeA.firmId, id);
    const revalidated = validateStatement(loaded!.draft);
    expect(revalidated.ok).toBe(true);
    if (revalidated.ok) expect(reconcile(revalidated.value).reconciled).toBe(true);
  });

  it("preserves line order and provenance", async () => {
    const statement = balanced({ lineCount: 12 });
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    const loaded = await loadStatement(harness.db, scopeA.firmId, id);
    expect(loaded!.draft.lines.map((l) => l.dateRaw)).toEqual(
      statement.lines.map((l) => l.dateRaw),
    );
    expect(loaded!.draft.lines[0]?.source.locator).toBe("row:1");
    expect(loaded!.draft.lines[0]?.source.page).toBe(1);
  });

  it("keeps an absent running balance absent, not zero", async () => {
    const statement = balanced();
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    const loaded = await loadStatement(harness.db, scopeA.firmId, id);
    expect(loaded!.draft.lines[0]?.runningBalance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bigint precision
// ---------------------------------------------------------------------------

describe("money survives the database above Number.MAX_SAFE_INTEGER", () => {
  // 9_007_199_254_740_993 is MAX_SAFE_INTEGER + 2: the smallest integer that a
  // JavaScript number cannot represent. If any layer coerced to a number it
  // would come back as ...992 and the assertion would fail.
  const HUGE = 9_007_199_254_740_993n;

  it("round-trips a balance beyond float precision", async () => {
    const statement = balanced({ openingBalance: sen(HUGE) });
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    const loaded = await loadStatement(harness.db, scopeA.firmId, id);
    expect(loaded!.draft.openingBalance).toBe(HUGE);
    expect(typeof loaded!.draft.openingBalance).toBe("bigint");
    // The proof that precision was not lost: the value a number would have
    // produced is different.
    expect(loaded!.draft.openingBalance).not.toBe(BigInt(Number(HUGE)));
  });

  it("round-trips a provider cost beyond float precision", async () => {
    const runId = await createExtractionRun(harness.db, scopeA);
    const record: ModelCallRecord = {
      documentId: scopeA.documentId,
      provider: "fake",
      model: "fake-model-1",
      rateTableVersion: "test-fixture-v1",
      currency: "USD",
      estimatedMaximumCost: microcents(HUGE),
      actualCost: microcents(HUGE - 1n),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      startedAt: "2026-07-29T12:00:00.000Z",
      completedAt: "2026-07-29T12:00:01.000Z",
      outcome: "succeeded",
    };
    await saveProviderCall(harness.db, scopeA.firmId, runId, record, MODE);

    const calls = await loadProviderCalls(harness.db, scopeA.firmId, runId);
    expect(calls[0]?.estimatedMaximumCost).toBe(HUGE);
    expect(calls[0]?.actualCost).toBe(HUGE - 1n);
  });

  it("refuses a number where a bigint column is expected", () => {
    // The boundary catching a driver misconfigured to mode:"number". A silently
    // truncated balance that looks plausible is worse than a crash.
    expect(() => senFromDb(1234)).toThrow(/expected a bigint/);
    expect(() => microcentsFromDb(1234)).toThrow(/expected a bigint/);
    expect(() => senFromDb("1234")).toThrow(/expected a bigint/);
    expect(senFromDbNullable(null)).toBeUndefined();
  });

  it("re-validates a date read back rather than trusting it", () => {
    expect(isoDateFromDb("2026-07-14")).toBe("2026-07-14");
    expect(() => isoDateFromDb("2026-02-30")).toThrow(/non-calendar date/);
    expect(() => isoDateFromDb(20260714)).toThrow(/expected a date column/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("does not return another firm's statement", async () => {
    const statement = balanced();
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    expect(await loadStatement(harness.db, scopeA.firmId, id)).not.toBeNull();
    // Correct id, wrong firm: nothing.
    expect(await loadStatement(harness.db, scopeB.firmId, id)).toBeNull();
  });

  it("does not return another firm's provider calls", async () => {
    const runId = await createExtractionRun(harness.db, scopeA);
    const record: ModelCallRecord = {
      documentId: scopeA.documentId,
      provider: "fake",
      model: "m",
      rateTableVersion: "v1",
      currency: "USD",
      startedAt: "2026-07-29T12:00:00.000Z",
      completedAt: "2026-07-29T12:00:01.000Z",
      outcome: "provider-invocation-failed",
    };
    await saveProviderCall(harness.db, scopeA.firmId, runId, record, MODE);

    expect(await loadProviderCalls(harness.db, scopeA.firmId, runId)).toHaveLength(1);
    expect(await loadProviderCalls(harness.db, scopeB.firmId, runId)).toHaveLength(0);
  });

  it("rejects a run whose document belongs to another firm", async () => {
    // The composite foreign key, enforced by the database rather than by a
    // filter someone remembered to write.
    await expect(
      createExtractionRun(harness.db, {
        firmId: scopeB.firmId,
        clientId: scopeB.clientId,
        documentId: scopeA.documentId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a statement pointing at another firm's run", async () => {
    const runId = await createExtractionRun(harness.db, scopeA);
    const statement = balanced();
    await expect(
      saveStatement(
        harness.db,
        { ...scopeB, documentId: scopeB.documentId },
        runId,
        statement,
        reconcile(statement),
      ),
    ).rejects.toThrow();
  });

  it("scopes uniqueness per firm", async () => {
    // Two firms may each have a run at attempt 1 for their own document.
    await createExtractionRun(harness.db, scopeA);
    await createExtractionRun(harness.db, scopeB);
    // The same firm may not repeat an attempt number.
    await expect(createExtractionRun(harness.db, scopeA)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Database-level invariants
// ---------------------------------------------------------------------------

describe("the database enforces the domain invariants", () => {
  it("refuses a statement claiming to reconcile with a non-zero delta", async () => {
    const statement = balanced();
    const runId = await createExtractionRun(harness.db, scopeA);
    const honest = reconcile(statement);

    await expect(
      saveStatement(harness.db, scopeA, runId, statement, {
        ...honest,
        reconciled: true,
        delta: sen(1n),
      }),
    ).rejects.toThrow();
  });

  it("stores an unreconciled statement with its delta", async () => {
    const draft = corruptLineAmount(
      buildStatementDraft({ documentId: scopeA.documentId, lineCount: 6 }),
      2,
      1n,
    );
    const validated = validateStatement(draft);
    if (!validated.ok) throw new Error("fixture invalid");
    const result = reconcile(validated.value);
    expect(result.reconciled).toBe(false);

    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, validated.value, result);

    const loaded = await loadStatement(harness.db, scopeA.firmId, id);
    expect(loaded!.reconciled).toBe(false);
    expect(loaded!.deltaSen).toBe(result.delta);
  });

  it("allows at most one successful run per document", async () => {
    // The idempotency backstop for concurrent workers.
    const first = await createExtractionRun(harness.db, scopeA, 1);
    const second = await createExtractionRun(harness.db, scopeA, 2);
    await completeExtractionRun(harness.db, scopeA.firmId, first, {
      status: "succeeded",
    });
    await expect(
      completeExtractionRun(harness.db, scopeA.firmId, second, {
        status: "succeeded",
      }),
    ).rejects.toThrow();
  });

  it("permits many failed attempts alongside one success", async () => {
    const a = await createExtractionRun(harness.db, scopeA, 1);
    const b = await createExtractionRun(harness.db, scopeA, 2);
    const c = await createExtractionRun(harness.db, scopeA, 3);
    await completeExtractionRun(harness.db, scopeA.firmId, a, { status: "failed" });
    await completeExtractionRun(harness.db, scopeA.firmId, b, { status: "exception" });
    await completeExtractionRun(harness.db, scopeA.firmId, c, { status: "succeeded" });
    // No throw.
    expect(true).toBe(true);
  });

  it("refuses a line with both a debit and a credit", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const statement = balanced();
    const runId = await createExtractionRun(harness.db, scopeA);
    const id = await saveStatement(harness.db, scopeA, runId, statement, reconcile(statement));

    await expect(
      db.execute(
        sql`insert into statement_lines (id, firm_id, statement_id, line_index,
              transaction_date, date_raw, description, debit_sen, credit_sen, source_page)
            values (${uuidv7()}, ${scopeA.firmId}, ${id}, 999, '2026-07-14', '14/07/2026',
                    'X', 100, 100, 1)`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The M3 firewall, at the schema
// ---------------------------------------------------------------------------

describe("no M3 concept reached the schema", () => {
  const MIGRATION = join(
    process.cwd(),
    "lib",
    "db",
    "migrations",
    "0005_create_m2_extraction_schema.sql",
  );

  /** Vocabulary belonging to a posting (M3a) or destination artifact (M3b).
   *  Compound where a bare word would collide with ordinary SQL. */
  const FORBIDDEN = [
    "gl_account",
    "tax_code",
    "posting",
    "reviewer",
    "approval",
    "approved_by",
    "chart_of_account",
    "supplier_code",
    "customer_code",
    "sage",
    "sql_account",
    "import_template",
    "export_status",
    "destination",
    "invoice_number",
    "billing",
  ];

  function statements(sqlText: string): string {
    // Comments discuss these concepts by name; only DDL may not embody them.
    return sqlText.replace(/--.*$/gm, "").toLowerCase();
  }

  it("keeps posting and destination vocabulary out of migration 0005", () => {
    const ddl = statements(readFileSync(MIGRATION, "utf8"));
    for (const token of FORBIDDEN) {
      expect(ddl.includes(token)).toBe(false);
    }
  });

  it("keeps it out of every M2 table definition in schema.ts", () => {
    const source = readFileSync(
      join(process.cwd(), "lib", "db", "schema.ts"),
      "utf8",
    );
    const m2 = source.slice(source.indexOf("// --- M2: extraction"));
    const code = m2.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const token of ["glAccount", "taxCode", "posting", "reviewer", "approval", "destination"]) {
      expect(code.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it("gives provider_calls no column capable of holding a payload", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = harness.db as any;
    const rows = await db.execute(
      sql`select column_name from information_schema.columns
          where table_name = 'provider_calls'`,
    );
    const names = (rows.rows ?? rows).map((r: Record<string, unknown>) =>
      String(r["column_name"]),
    );
    for (const forbidden of ["prompt", "response", "content", "body", "text", "payload", "messages"]) {
      expect(names.some((n: string) => n.includes(forbidden))).toBe(false);
    }
    expect(names).toContain("actual_cost_microcents");
  });

  it("has exactly one new forward migration", () => {
    const files = readdirSync(join(process.cwd(), "lib", "db", "migrations"))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith(".down.sql"))
      .sort();
    expect(files).toEqual([
      "0000_create_m1_tenancy_and_document_schema.sql",
      "0001_add_updated_at_trigger.sql",
      "0002_replace_authjs_tables_with_better_auth.sql",
      "0003_add_document_upload_state.sql",
      "0004_make_audit_events_append_only.sql",
      "0005_create_m2_extraction_schema.sql",
    ]);
  });
});
