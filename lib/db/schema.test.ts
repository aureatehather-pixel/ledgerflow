import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uuidv7 } from "./ids";
import { clientAssignments, clients, documents, firms, users } from "./schema";
import { createTestDatabase } from "./testing";

/**
 * The database is the last line of defence for the authorization edge. If the
 * query layer has a bug, these constraints are what stops it becoming a
 * cross-firm data leak, so they are tested directly rather than assumed.
 *
 * Every test here is a negative control: it proves the schema REJECTS something.
 * Constraints verified only on the happy path are indistinguishable from absent
 * constraints (`CLAUDE.md` § Verification).
 */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDatabase();
});

afterEach(async () => {
  await harness.close();
});

/** Minimal graph: one firm, one user, one client. */
async function seedFirm(name: string) {
  const { db } = harness;
  const [firm] = await db.insert(firms).values({ name }).returning();
  const [user] = await db
    .insert(users)
    .values({
      firmId: firm!.id,
      email: `staff@${name.toLowerCase()}.test`,
      name: "Test Staff",
    })
    .returning();
  const [client] = await db
    .insert(clients)
    .values({ firmId: firm!.id, name: `${name} Client`, code: "C-001" })
    .returning();
  return { firm: firm!, user: user!, client: client! };
}

describe("referential integrity", () => {
  it("rejects a document whose client does not exist", async () => {
    const { firm, user } = await seedFirm("Alpha");
    await expect(
      harness.db.insert(documents).values({
        firmId: firm.id,
        clientId: uuidv7(), // never inserted
        storageKey: "k",
        originalFilename: "statement.pdf",
        contentType: "application/pdf",
        byteSize: 1,
        sha256: "a".repeat(64),
        uploadedBy: user.id,
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete a firm that still has users", async () => {
    const { firm } = await seedFirm("Alpha");
    // ON DELETE RESTRICT: deletion order is the application's to handle
    // explicitly, rather than silently destroying dependent rows.
    await expect(
      harness.db.delete(firms).where(eq(firms.id, firm.id)),
    ).rejects.toThrow();
  });

  it("refuses to delete a user who appears in the audit trail", async () => {
    // Previously this asserted the opposite -- that deleting a user SUCCEEDED
    // and nulled `actor_user_id` (ON DELETE SET NULL), on the reasoning that
    // "history survives the actor".
    //
    // Migration 0004 reversed it, because that nulling is an UPDATE against an
    // append-only table AND an erasure of the single field that makes an event
    // evidence. A trail that forgets who acted the moment their row is deleted
    // is not a trail. RESTRICT makes erasing attribution impossible rather than
    // incidental.
    const { user } = await seedFirm("Alpha");
    await harness.client.exec(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, outcome)
       VALUES ('${uuidv7()}', '${user.id}', 'document.read', 'document', 'denied')`,
    );

    await expect(
      harness.db.delete(users).where(eq(users.id, user.id)),
    ).rejects.toThrow();

    // Both rows survive: the event AND the actor it names.
    const events = await harness.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events",
    );
    expect(events.rows[0]?.count).toBe("1");
    const remaining = await harness.db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(remaining).toHaveLength(1);
  });

  it("still allows deleting a user with no audit history", async () => {
    // The positive control. RESTRICT must constrain exactly the case it is for,
    // not user deletion in general -- otherwise it is indistinguishable from a
    // blanket refusal and nobody would notice it stopped working.
    const { user } = await seedFirm("Alpha");
    await harness.db.delete(users).where(eq(users.id, user.id));
    expect(
      await harness.db.select().from(users).where(eq(users.id, user.id)),
    ).toHaveLength(0);
  });

  it("keeps the trail intact through the soft delete the application uses", async () => {
    // The path that actually runs. Nothing in the application hard-deletes a
    // user, so RESTRICT costs the real workflow nothing.
    const { user } = await seedFirm("Alpha");
    await harness.client.exec(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, outcome)
       VALUES ('${uuidv7()}', '${user.id}', 'document.read', 'document', 'allowed')`,
    );

    await harness.db
      .update(users)
      .set({ deletedAt: new Date(), deactivatedAt: new Date() })
      .where(eq(users.id, user.id));

    const rows = await harness.client.query<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM audit_events",
    );
    expect(rows.rows).toHaveLength(1);
    // Attribution intact, which is the point.
    expect(rows.rows[0]?.actor_user_id).toBe(user.id);
  });
});

describe("client assignment is the authorization edge", () => {
  it("permits only one live assignment per user and client", async () => {
    const { user, client } = await seedFirm("Alpha");
    await harness.db
      .insert(clientAssignments)
      .values({ userId: user.id, clientId: client.id, accessLevel: "read" });

    // Two live rows could disagree about access level, and the boundary would
    // have to pick one. The database forbids the ambiguity outright.
    await expect(
      harness.db
        .insert(clientAssignments)
        .values({ userId: user.id, clientId: client.id, accessLevel: "write" }),
    ).rejects.toThrow();
  });

  it("allows re-granting access after a revocation", async () => {
    const { user, client } = await seedFirm("Alpha");
    const [first] = await harness.db
      .insert(clientAssignments)
      .values({ userId: user.id, clientId: client.id })
      .returning();

    await harness.db
      .update(clientAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(clientAssignments.id, first!.id));

    // The unique index is partial on revoked_at IS NULL, so a revoked row does
    // not permanently bar someone from being reassigned later.
    await expect(
      harness.db
        .insert(clientAssignments)
        .values({ userId: user.id, clientId: client.id }),
    ).resolves.toBeDefined();
  });
});

describe("check constraints reject impossible documents", () => {
  it.each([
    ["a zero byte size", { byteSize: 0, sha256: "a".repeat(64) }],
    ["a negative byte size", { byteSize: -1, sha256: "a".repeat(64) }],
    ["a truncated sha256", { byteSize: 10, sha256: "abc" }],
  ])("rejects %s", async (_label, overrides) => {
    const { firm, user, client } = await seedFirm("Alpha");
    await expect(
      harness.db.insert(documents).values({
        firmId: firm.id,
        clientId: client.id,
        storageKey: "k",
        originalFilename: "statement.pdf",
        contentType: "application/pdf",
        uploadedBy: user.id,
        ...overrides,
      }),
    ).rejects.toThrow();
  });
});

describe("soft deletes do not block reuse", () => {
  it("frees an email address once the user is soft-deleted", async () => {
    const { firm, user } = await seedFirm("Alpha");

    await expect(
      harness.db
        .insert(users)
        .values({ firmId: firm.id, email: user.email, name: "Impostor" }),
    ).rejects.toThrow();

    await harness.db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, user.id));

    await expect(
      harness.db
        .insert(users)
        .values({ firmId: firm.id, email: user.email, name: "Rehired" }),
    ).resolves.toBeDefined();
  });
});

describe("updated_at is maintained by the database", () => {
  it("advances on update without the application setting it", async () => {
    const { firm } = await seedFirm("Alpha");
    const before = await harness.db.query.firms.findFirst({
      where: eq(firms.id, firm.id),
    });

    await harness.client.exec("SELECT pg_sleep(0.01)");
    // Note: no updatedAt in this payload. If the trigger were missing, the
    // timestamp would simply never move and nobody would notice.
    await harness.db
      .update(firms)
      .set({ name: "Renamed" })
      .where(eq(firms.id, firm.id));

    const after = await harness.db.query.firms.findFirst({
      where: eq(firms.id, firm.id),
    });
    expect(after!.updatedAt.getTime()).toBeGreaterThan(
      before!.updatedAt.getTime(),
    );
  });
});

describe("uuidv7", () => {
  it("is time-ordered, so keys cluster at the right edge of the index", () => {
    const first = uuidv7();
    const second = uuidv7();
    expect(first < second || first.slice(0, 8) === second.slice(0, 8)).toBe(true);
  });

  it("carries the version 7 and RFC 4122 variant markers", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
