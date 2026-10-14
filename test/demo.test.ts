/**
 * The public demonstration: `npm run demo`.
 *
 * One synthetic accounting firm, one synthetic client, one synthetic bank
 * statement, walked through the canonical code paths in order. Every step is a
 * test, so the demo cannot drift from what the code does: if a guarantee below
 * stops holding, the demo goes red instead of telling a story that is no longer
 * true.
 *
 * Offline by construction. Postgres is PGlite in-process, provisioned by the
 * same SQL migrations production applies. Object storage is the in-memory port
 * implementation. No network, no credentials, no model call, no client document.
 *
 * What this does NOT show, because it does not exist yet: a bank-statement
 * parser, any model-based extraction, or an accounting-system export. The
 * statement in step 4 is typed in below, line by line, from printed tokens.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/audit";
import type { AuthenticatedActor } from "@/lib/auth/session";
import { provisionUser } from "@/lib/auth/users";
import { grantClientAccessForActor, readDocumentForActor } from "@/lib/authz/operations";
import { auditEvents, clients, firms } from "@/lib/db/schema";
import { createTestDatabase } from "@/lib/db/testing";
import { parseStatementDate } from "@/lib/domain/dates";
import { addSen, formatSen, parseMagnitude, type Sen } from "@/lib/domain/money";
import { validateStatement, type StatementDraft, type StatementLine } from "@/lib/domain/statement";
import { reconcile, requireReconciled } from "@/lib/reconcile";
import { memoryStore } from "@/lib/storage/memory";
import { uploadDocument } from "@/lib/upload";

// ---------------------------------------------------------------------------
// Synthetic world
// ---------------------------------------------------------------------------

const PASSWORD = "synthetic demo password, not a secret";

/** A minimal, genuinely well-formed PDF. The signature check reads real bytes. */
const SYNTHETIC_PDF = new TextEncoder().encode(
  "%PDF-1.4\n% SYNTHETIC DEMO DOCUMENT - not a real statement\n1 0 obj\n<<>>\nendobj\n",
);
/** PNG magic bytes, about to be presented as a PDF. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
let database: Db;
const store = memoryStore();

let partner: AuthenticatedActor;
let staff: AuthenticatedActor;
let colleague: AuthenticatedActor;
let outsider: AuthenticatedActor;
let clientId: string;
let documentId: string;

function messageChain(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    parts.push(current.message);
  }
  return parts.join(" | ");
}

function actor(
  user: { id: string; email: string },
  firmId: string,
  firmRole: AuthenticatedActor["firmRole"],
): AuthenticatedActor {
  // Sessions are covered by lib/auth/auth.test.ts. The demo starts after
  // sign-in, at the authorization boundary.
  return {
    userId: user.id,
    firmId,
    email: user.email,
    firmRole,
    sessionId: "00000000-0000-7000-8000-000000000000",
    sessionCreatedAt: new Date(),
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;

  const [firm] = await db.insert(firms).values({ name: "Demo Accounting (synthetic)" }).returning();
  const [otherFirm] = await db.insert(firms).values({ name: "Other Firm (synthetic)" }).returning();
  const [client] = await db
    .insert(clients)
    .values({ firmId: firm!.id, name: "SAMPLE TRADING SDN BHD (synthetic)", code: "SAMPLE" })
    .returning();
  clientId = client!.id;

  const person = async (email: string, firmId: string, role: AuthenticatedActor["firmRole"]) =>
    actor(
      await provisionUser(db, { firmId, email, name: email, password: PASSWORD, firmRole: role }),
      firmId,
      role,
    );

  partner = await person("partner@demo.test", firm!.id, "partner");
  staff = await person("staff@demo.test", firm!.id, "staff");
  colleague = await person("colleague@demo.test", firm!.id, "staff");
  outsider = await person("partner@other-firm.test", otherFirm!.id, "partner");
});

afterAll(async () => {
  await database.close();
});

// ---------------------------------------------------------------------------
// The walk-through. Steps share state and run in order.
// ---------------------------------------------------------------------------

describe("1. client-assignment authorization", () => {
  it("refuses a staff member who tries to grant themselves access", async () => {
    const result = await grantClientAccessForActor(database.db, staff, {
      userId: staff.userId,
      clientId,
      accessLevel: "write",
    });
    expect(result).toEqual({ ok: false, error: "DENIED" });
  });

  it("lets a partner assign the client to one staff member", async () => {
    const result = await grantClientAccessForActor(database.db, partner, {
      userId: staff.userId,
      clientId,
      accessLevel: "write",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("2. guarded upload into private storage", () => {
  it("refuses a file whose bytes contradict its declared type, before storing anything", async () => {
    const result = await uploadDocument({ db: database.db, store }, staff, {
      clientId,
      filename: "statement.pdf",
      declaredType: "application/pdf",
      bytes: PNG_BYTES,
    });
    expect(result).toEqual({ ok: false, error: "INVALID", reason: "SIGNATURE_MISMATCH" });
    expect(store.putCount).toBe(0);
  });

  it("refuses an upload from a colleague with no assignment to this client", async () => {
    const result = await uploadDocument({ db: database.db, store }, colleague, {
      clientId,
      filename: "statement.pdf",
      declaredType: "application/pdf",
      bytes: SYNTHETIC_PDF,
    });
    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(store.putCount).toBe(0);
  });

  it("accepts a synthetic PDF and stores it under a server-generated, tenant-scoped key", async () => {
    const result = await uploadDocument({ db: database.db, store }, staff, {
      clientId,
      filename: "../../etc/statement.pdf",
      declaredType: "application/pdf",
      bytes: SYNTHETIC_PDF,
    });
    expect(result).toMatchObject({ ok: true, deduplicated: false });
    if (!result.ok) throw new Error("unreachable");
    documentId = result.documentId;

    const keys = [...store.objects.keys()];
    expect(keys).toEqual([
      `firms/${staff.firmId}/clients/${clientId}/documents/${documentId}`,
    ]);
    // The caller's filename never reaches the key, so it cannot steer the path.
    expect(keys[0]).not.toContain("etc");
    expect(store.objects.get(keys[0]!)?.bytes).toEqual(SYNTHETIC_PDF);
  });
});

describe("3. reading a document: firm membership grants nothing", () => {
  it("lets the assigned staff member read it", async () => {
    const result = await readDocumentForActor(database.db, staff, documentId);
    expect(result).toMatchObject({ ok: true, document: { id: documentId, clientId } });
  });

  it("refuses an unassigned colleague in the same firm", async () => {
    expect(await readDocumentForActor(database.db, colleague, documentId)).toEqual({
      ok: false,
      error: "DENIED",
    });
  });

  it("refuses the partner of another firm, with the same answer as a missing document", async () => {
    const foreign = await readDocumentForActor(database.db, outsider, documentId);
    const missing = await readDocumentForActor(
      database.db,
      outsider,
      "00000000-0000-7000-8000-00000000dead",
    );
    expect(foreign).toEqual({ ok: false, error: "DENIED" });
    expect(missing).toEqual(foreign);
  });
});

describe("4. the append-only audit trail", () => {
  it("recorded every access decision above, allowed and denied", async () => {
    const rows = await database.db
      .select({ action: auditEvents.action, outcome: auditEvents.outcome })
      .from(auditEvents)
      .orderBy(auditEvents.occurredAt);

    const tally = (action: string, outcome: string) =>
      rows.filter((r) => r.action === action && r.outcome === outcome).length;

    expect(tally(AUDIT_ACTIONS.CLIENT_ACCESS_GRANT, "denied")).toBe(1);
    expect(tally(AUDIT_ACTIONS.CLIENT_ACCESS_GRANT, "allowed")).toBe(1);
    expect(tally(AUDIT_ACTIONS.DOCUMENT_UPLOAD, "denied")).toBe(1);
    expect(tally(AUDIT_ACTIONS.DOCUMENT_UPLOAD, "allowed")).toBe(1);
    expect(tally(AUDIT_ACTIONS.DOCUMENT_READ, "allowed")).toBe(1);
    expect(tally(AUDIT_ACTIONS.DOCUMENT_READ, "denied")).toBe(3);
    // The mismatched-signature upload is input validation, not an access
    // decision, so it is deliberately absent (docs/decisions/0002).
    expect(rows).toHaveLength(8);
  });

  it("refuses to rewrite history, at the database", async () => {
    const error: unknown = await database.db
      .update(auditEvents)
      .set({ outcome: "allowed" })
      .where(eq(auditEvents.outcome, "denied"))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    // Drizzle wraps the driver error; the trigger's own words are in the cause.
    expect(messageChain(error)).toMatch(/audit_events is append-only/);

    const [{ denied }] = (await database.db.execute(
      sql`select count(*)::int as denied from audit_events where outcome = 'denied'`,
    )).rows as [{ denied: number }];
    expect(denied).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The arithmetic. No database involved: lib/reconcile is pure.
// ---------------------------------------------------------------------------

/** Printed rows, exactly as a statement shows them: DD/MM/YYYY, grouped amounts. */
const PRINTED = {
  opening: "5,000.00",
  closing: "3,145.25",
  rows: [
    ["13/07/2026", "SYNTHETIC SALES RECEIPT", "", "1,250.40"],
    ["15/07/2026", "SYNTHETIC SUPPLIER PAYMENT", "3,105.25", ""],
    ["20/07/2026", "SYNTHETIC BANK CHARGE", "0.10", ""],
    ["28/07/2026", "SYNTHETIC CASH DEPOSIT", "", "0.20"],
  ],
} as const;

function money(token: string): Sen {
  const parsed = parseMagnitude(token === "" ? "0.00" : token);
  if (!parsed.ok) throw new Error(parsed.failure.detail);
  return parsed.value;
}

function statementFrom(rows: readonly (readonly [string, string, string, string])[]): StatementDraft {
  const documentId = "00000000-0000-7000-8000-00000000d3a0";
  const lines: StatementLine[] = rows.map(([dateRaw, description, debit, credit], i) => {
    const date = parseStatementDate(dateRaw);
    if (!date.ok) throw new Error(date.failure.detail);
    return {
      date: date.value.value,
      dateRaw,
      description,
      debit: money(debit),
      credit: money(credit),
      source: { documentId, page: 1, locator: `row:${i + 1}` },
    };
  });
  return {
    accountReference: "SAMPLEBANK 0000000000",
    currency: "MYR",
    periodStart: lines[0]!.date,
    periodEnd: lines[lines.length - 1]!.date,
    openingBalance: money(PRINTED.opening),
    closingBalance: money(PRINTED.closing),
    lines,
    source: { documentId, pageCount: 1 },
  };
}

describe("5. exact money and unambiguous dates", () => {
  it("holds amounts as integer sen, so 0.10 + 0.20 is exactly 0.30", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the float problem this avoids
    expect(formatSen(addSen(money("0.10"), money("0.20")))).toBe("0.30");
  });

  it("refuses 03/04/2026 until a day/month convention is stated", () => {
    const guessed = parseStatementDate("03/04/2026");
    expect(guessed).toMatchObject({ ok: false, failure: { kind: "AMBIGUOUS_DATE" } });
    expect(parseStatementDate("03/04/2026", { assume: "DMY" })).toMatchObject({
      ok: true,
      value: { value: "2026-04-03" },
    });
  });
});

describe("6. reconciliation is a gate: opening + credits - debits = closing", () => {
  it("passes a synthetic statement that balances to the sen", () => {
    const statement = validateStatement(statementFrom(PRINTED.rows));
    if (!statement.ok) throw new Error(statement.failure.detail);

    const result = reconcile(statement.value);
    expect(formatSen(result.computedClosing)).toBe(PRINTED.closing);
    expect(result.delta).toBe(0n);
    expect(requireReconciled(statement.value).ok).toBe(true);
  });

  it("rejects the same statement with one amount misread by 1 sen", () => {
    const misread = PRINTED.rows.map((row) =>
      row[1] === "SYNTHETIC BANK CHARGE" ? ([row[0], row[1], "0.11", row[3]] as const) : row,
    );
    const statement = validateStatement(statementFrom(misread));
    if (!statement.ok) throw new Error(statement.failure.detail);

    expect(reconcile(statement.value).delta).toBe(-1n);
    expect(requireReconciled(statement.value)).toMatchObject({
      ok: false,
      failure: { kind: "RECONCILIATION_FAILED" },
    });
  });
});
