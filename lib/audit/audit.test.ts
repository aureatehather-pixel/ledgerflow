import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthHarness, type AuthHarness } from "@/lib/auth/testing";
import { auditEvents } from "@/lib/db/schema";
import { failAuditInserts } from "@/lib/db/testing";

import {
  AUDIT_ACTIONS,
  AUDIT_DENIAL_REASONS,
  AuditDetailError,
  AuditWriteError,
  allowedDetailKeys,
  auditableId,
  recordAuditEvent,
} from "./index";

const PASSWORD = "correct horse battery staple";

/**
 * Flattens an error and its `cause` chain into one string.
 *
 * Drizzle wraps a driver error in its own ("Failed query: ..."), so asserting on
 * the top-level message alone would pass for ANY failed statement -- including a
 * syntax error -- and prove nothing about the trigger. The database's own words
 * are what has to be matched.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

let h: AuthHarness;
let actorUserId: string;

beforeEach(async () => {
  h = await createAuthHarness();
  const user = await h.createUser({ email: "actor@x.test", password: PASSWORD });
  actorUserId = user.id;
});
afterEach(async () => {
  await h.close();
});

// ---------------------------------------------------------------------------
// The write itself
// ---------------------------------------------------------------------------

describe("recordAuditEvent", () => {
  it("appends the actor, action, resource, outcome and a timestamp", async () => {
    const before = new Date();
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: "00000000-0000-7000-8000-00000000beef",
      outcome: "allowed",
      detail: { clientId: "00000000-0000-7000-8000-0000000000c1" },
    });

    const [row] = await h.db.select().from(auditEvents);
    expect(row!.actorUserId).toBe(actorUserId);
    expect(row!.action).toBe("document.read");
    expect(row!.resourceType).toBe("document");
    expect(row!.resourceId).toBe("00000000-0000-7000-8000-00000000beef");
    expect(row!.outcome).toBe("allowed");
    expect(row!.detail).toEqual({
      clientId: "00000000-0000-7000-8000-0000000000c1",
    });
    // A5-style completeness: every field A7 names is populated, not just present.
    expect(row!.occurredAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it("records a denial with its reason", async () => {
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "denied",
      detail: { reason: AUDIT_DENIAL_REASONS.NOT_READABLE },
    });

    const [row] = await h.db.select().from(auditEvents);
    expect(row!.outcome).toBe("denied");
    expect(row!.resourceId).toBeNull();
    expect(row!.detail).toEqual({ reason: "not_readable" });
  });

  it("throws AuditWriteError, carrying the cause, when the row cannot be written", async () => {
    await failAuditInserts(h.client);

    const attempt = recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "allowed",
    });

    await expect(attempt).rejects.toBeInstanceOf(AuditWriteError);
    // The cause survives: a failure the operator cannot diagnose is barely
    // better than a swallowed one.
    await attempt.catch((error: AuditWriteError) => {
      expect(error.cause).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Detail allowlist — the negative control on what may be logged
// ---------------------------------------------------------------------------

describe("detail allowlist", () => {
  it("rejects a key outside the allowlist before touching the database", async () => {
    await expect(
      recordAuditEvent(h.db, {
        actorUserId,
        action: AUDIT_ACTIONS.DOCUMENT_READ,
        resourceType: "document",
        resourceId: null,
        outcome: "allowed",
        detail: { clientId: "x", note: "anything" } as Record<string, string>,
      }),
    ).rejects.toBeInstanceOf(AuditDetailError);

    expect(await h.db.select().from(auditEvents)).toHaveLength(0);
  });

  it.each([
    ["filename", "statement.pdf"],
    ["originalFilename", "Tan Ah Kow — Maybank Jan.pdf"],
    ["sha256", "a".repeat(64)],
    ["bytes", "%PDF-1.4"],
    ["contents", "opening balance 1,234.56"],
    ["secret", "r2-token"],
    ["error", "duplicate key value violates unique constraint"],
  ])("refuses to log %s", async (key, value) => {
    await expect(
      recordAuditEvent(h.db, {
        actorUserId,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
        resourceType: "document",
        resourceId: null,
        outcome: "allowed",
        detail: { [key]: value },
      }),
    ).rejects.toBeInstanceOf(AuditDetailError);
    expect(await h.db.select().from(auditEvents)).toHaveLength(0);
  });

  it("names no forbidden category in any action's allowlist", () => {
    const forbidden = [
      "filename",
      "originalFilename",
      "sha256",
      "hash",
      "bytes",
      "contents",
      "secret",
      "token",
      "password",
      "error",
      "message",
      "stack",
    ];
    for (const action of Object.values(AUDIT_ACTIONS)) {
      for (const key of allowedDetailKeys(action)) {
        expect(forbidden).not.toContain(key);
      }
    }
  });

  it("is a positive control too: allowed keys do get written", async () => {
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.CLIENT_ACCESS_GRANT,
      resourceType: "client",
      resourceId: null,
      outcome: "allowed",
      detail: {
        targetUserId: "00000000-0000-7000-8000-00000000000a",
        accessLevel: "write",
      },
    });
    const [row] = await h.db.select().from(auditEvents);
    expect(row!.detail).toEqual({
      targetUserId: "00000000-0000-7000-8000-00000000000a",
      accessLevel: "write",
    });
  });
});

describe("auditableId", () => {
  it("admits a UUID and rejects everything else", () => {
    expect(auditableId("00000000-0000-7000-8000-00000000beef")).toBe(
      "00000000-0000-7000-8000-00000000beef",
    );
    expect(auditableId("'; DROP TABLE documents;--")).toBeNull();
    expect(auditableId("")).toBeNull();
    expect(auditableId(null)).toBeNull();
    expect(auditableId(undefined)).toBeNull();
    expect(auditableId("x".repeat(10_000))).toBeNull();
  });

  it("keeps a malformed identifier from becoming a driver error", async () => {
    // The point of the guard: without it this insert raises, and a raised
    // denial has a different shape from an ordinary one.
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: auditableId("not-a-uuid"),
      outcome: "denied",
      detail: { reason: AUDIT_DENIAL_REASONS.NOT_READABLE },
    });
    const [row] = await h.db.select().from(auditEvents);
    expect(row!.resourceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Append-only — migration 0004's negative control
// ---------------------------------------------------------------------------

describe("audit_events is append-only", () => {
  it("rejects an UPDATE at the database, not in application code", async () => {
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "denied",
      detail: { reason: AUDIT_DENIAL_REASONS.NOT_READABLE },
    });
    const [row] = await h.db.select().from(auditEvents);

    // Raw SQL on purpose: this must hold against anything that can reach the
    // database, not only against code that goes through Drizzle.
    const error = await h.db
      .execute(
        sql`UPDATE audit_events SET outcome = 'allowed' WHERE id = ${row!.id}`,
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(messageChain(error)).toMatch(
      /audit_events is append-only: UPDATE is not permitted/i,
    );

    const [after] = await h.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, row!.id));
    expect(after!.outcome).toBe("denied");
  });

  it("rejects a mass UPDATE that touches no column of interest", async () => {
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "allowed",
    });
    const error = await h.db
      .execute(sql`UPDATE audit_events SET action = action`)
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).not.toBeNull();
    expect(messageChain(error)).toMatch(
      /audit_events is append-only: UPDATE is not permitted/i,
    );
  });

  it("still permits INSERT — the trigger blocks rewriting, not recording", async () => {
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "allowed",
    });
    await recordAuditEvent(h.db, {
      actorUserId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      resourceId: null,
      outcome: "denied",
      detail: { reason: AUDIT_DENIAL_REASONS.NOT_READABLE },
    });
    expect(await h.db.select().from(auditEvents)).toHaveLength(2);
  });

  it("is installed as a trigger, verified by introspection", async () => {
    const rows = await h.db.execute(sql`
      SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal
    `);
    const names = [...rows.rows].map((r) => (r as { tgname: string }).tgname);
    expect(names).toContain("audit_events_reject_update");
    // 0001 deliberately gave audit_events no updated_at trigger; if one ever
    // appears it would be an UPDATE on an append-only table by construction.
    expect(names).not.toContain("audit_events_set_updated_at");
  });
});
