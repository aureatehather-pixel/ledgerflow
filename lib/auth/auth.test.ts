import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accounts, sessions, users } from "@/lib/db/schema";

import { hashPassword, verifyPassword } from "./password";
import {
  COOKIE_CACHE_ENABLED,
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_IDLE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./policy";
import { getAuthenticatedActor } from "./session";
import { createAuthHarness, type AuthHarness } from "./testing";
import { deactivateUser, normalizeEmail, softDeleteUser } from "./users";

const PASSWORD = "correct horse battery staple";
const MIGRATIONS = join(process.cwd(), "lib", "db", "migrations");

let h: AuthHarness;

beforeEach(async () => {
  h = await createAuthHarness();
});

afterEach(async () => {
  await h.close();
});

/** Reads the session row Better Auth created for a user. */
async function sessionRowFor(userId: string) {
  const rows = await h.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows[0];
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe("migrations", () => {
  async function applyFiles(client: PGlite, files: string[]) {
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      for (const statement of sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean)) {
        await client.exec(statement);
      }
    }
  }

  const upMigrations = () =>
    readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
      .sort();

  it("applies cleanly to an empty database", async () => {
    const client = new PGlite();
    await expect(applyFiles(client, upMigrations())).resolves.not.toThrow();
    await client.close();
  });

  it("applies 0002 on top of the commit-2 schema", async () => {
    const client = new PGlite();
    const all = upMigrations();
    // Stop at the commit-2 state first, exactly as a deployed database would be.
    await applyFiles(
      client,
      all.filter((f) => f.startsWith("0000") || f.startsWith("0001")),
    );
    const before = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(before.rows.map((r) => r.table_name)).toContain("user_credentials");

    await expect(
      applyFiles(
        client,
        all.filter((f) => f.startsWith("0002")),
      ),
    ).resolves.not.toThrow();
    await client.close();
  });

  it("leaves every domain table untouched", async () => {
    const rows = await h.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const names = rows.rows.map((r) => r.table_name);
    for (const domain of [
      "firms",
      "clients",
      "client_assignments",
      "documents",
      "audit_events",
    ]) {
      expect(names).toContain(domain);
    }
  });

  it("removes user_credentials entirely", async () => {
    const rows = await h.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(rows.rows.map((r) => r.table_name)).not.toContain("user_credentials");
  });
});

// ---------------------------------------------------------------------------
// Sign-in and session creation
// ---------------------------------------------------------------------------

describe("sign-in", () => {
  it("creates a database session row on success", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const before = await sessionRowFor(user.id);
    expect(before).toBeUndefined();

    const result = await h.signIn("a@x.test", PASSWORD);
    expect(result.cookie).toBeTruthy();

    const row = await sessionRowFor(user.id);
    expect(row).toBeDefined();
    expect(row!.token).toBeTruthy();
    expect(row!.expiresAt).toBeInstanceOf(Date);
  });

  it("issues a session token with meaningful entropy", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    await h.signIn("a@x.test", PASSWORD);
    const rows = await h.db.select().from(sessions);
    const token: string = rows[0]!.token;
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(new Set(token).size).toBeGreaterThan(8);
  });

  it("mints distinct tokens for repeated sign-ins", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    await h.signIn("a@x.test", PASSWORD);
    await h.signIn("a@x.test", PASSWORD);
    const rows = await h.db.select().from(sessions);
    const tokens = new Set(rows.map((r: { token: string }) => r.token));
    expect(tokens.size).toBe(rows.length);
  });

  it("rejects an incorrect password", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const result = await h.signIn("a@x.test", "not the password");
    expect(result.cookie).toBeNull();
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it("treats an unknown user the same as a wrong password", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const wrongPassword = await h.signIn("a@x.test", "not the password");
    const unknownUser = await h.signIn("nobody@x.test", PASSWORD);

    // Same status and same body: nothing in the response tells an attacker
    // whether the address exists.
    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownUser.body).toBe(wrongPassword.body);
    expect(unknownUser.cookie).toBeNull();
  });

  it("has public sign-up disabled", async () => {
    const response = await h.auth.api.signUpEmail({
      body: { email: "intruder@x.test", password: PASSWORD, name: "X" },
      asResponse: true,
    });
    // The endpoint exists but refuses: 400, and no session cookie is issued.
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();

    const rows = await h.db
      .select()
      .from(users)
      .where(eq(users.email, "intruder@x.test"));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Where credentials live
// ---------------------------------------------------------------------------

describe("credential storage", () => {
  it("stores the Argon2id hash only in accounts.password", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });

    const [account] = await h.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, user.id));
    expect(account!.providerId).toBe("credential");
    expect(account!.password).toMatch(/^\$argon2id\$/);

    // The user row must carry no credential material of any kind.
    const [row] = await h.db.select().from(users).where(eq(users.id, user.id));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("argon2");
    expect(serialized).not.toContain(PASSWORD);
  });

  it("never exposes the hash or the password through the session API", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    const result = await h.auth.api.getSession({
      headers: h.headersFor(cookie!),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("argon2");
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("password");
  });

  it("never exposes the session token through the canonical helper", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    const actor = await getAuthenticatedActor({
      auth: h.auth,
      db: h.db,
      headers: h.headersFor(cookie!),
    });
    expect(actor).not.toBeNull();

    const rows = await h.db.select().from(sessions);
    const token: string = rows[0]!.token;
    expect(JSON.stringify(actor)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  it("consults persistent storage, so a deleted session fails immediately", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);

    const before = await getAuthenticatedActor({
      auth: h.auth,
      db: h.db,
      headers: h.headersFor(cookie!),
    });
    expect(before).not.toBeNull();

    await h.db.delete(sessions).where(eq(sessions.userId, user.id));

    // Same cookie, next request. If anything were cached, this would still pass.
    const after = await getAuthenticatedActor({
      auth: h.auth,
      db: h.db,
      headers: h.headersFor(cookie!),
    });
    expect(after).toBeNull();
  });

  it("expires after the inactivity window", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);

    // Simulate 30 minutes of silence by aging the sliding expiry past now.
    await h.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user.id));

    const actor = await getAuthenticatedActor({
      auth: h.auth,
      db: h.db,
      headers: h.headersFor(cookie!),
    });
    expect(actor).toBeNull();
  });

  it("pushes the idle window forward on activity", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);

    const first = await sessionRowFor(user.id);
    // Wind the sliding expiry back, still in the future, then make a request.
    const rewound = new Date(Date.now() + 5 * 60 * 1000);
    await h.db
      .update(sessions)
      .set({ expiresAt: rewound })
      .where(eq(sessions.userId, user.id));

    const actor = await getAuthenticatedActor({
      auth: h.auth,
      db: h.db,
      headers: h.headersFor(cookie!),
    });
    expect(actor).not.toBeNull();

    const after = await sessionRowFor(user.id);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(rewound.getTime());
    // created_at is immutable -- it is what the absolute cap measures.
    expect(after!.createdAt.getTime()).toBe(first!.createdAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// Absolute cap — boundary tests
// ---------------------------------------------------------------------------

describe("8-hour absolute cap", () => {
  async function actorAtAge(ageMs: number) {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    const row = await h.db.select().from(sessions);
    const createdAt: Date = row[0]!.createdAt;

    // Keep the sliding window open so only the absolute cap can deny.
    await h.db
      .update(sessions)
      .set({ expiresAt: new Date(createdAt.getTime() + ageMs + 60_000) });

    return {
      actor: await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
        now: () => new Date(createdAt.getTime() + ageMs),
      }),
      sessionId: row[0]!.id,
    };
  }

  it("allows a session one second before the cap", async () => {
    const { actor } = await actorAtAge(SESSION_ABSOLUTE_MAX_MS - 1000);
    expect(actor).not.toBeNull();
  });

  it("denies a session exactly at the cap", async () => {
    const { actor } = await actorAtAge(SESSION_ABSOLUTE_MAX_MS);
    expect(actor).toBeNull();
  });

  it("denies a session one second after the cap", async () => {
    const { actor } = await actorAtAge(SESSION_ABSOLUTE_MAX_MS + 1000);
    expect(actor).toBeNull();
  });

  it("deletes the session when the cap is exceeded", async () => {
    const { sessionId } = await actorAtAge(SESSION_ABSOLUTE_MAX_MS + 1000);
    const rows = await h.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });

  it("cannot be extended past the cap by continued activity", async () => {
    await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    const [row] = await h.db.select().from(sessions);
    const createdAt: Date = row!.createdAt;

    // Twelve requests spaced across nine hours. Each refreshes the sliding
    // window; none may push the session past its absolute maximum.
    let lastActor = null;
    for (let i = 1; i <= 12; i++) {
      const at = new Date(createdAt.getTime() + i * 45 * 60 * 1000);
      await h.db
        .update(sessions)
        .set({ expiresAt: new Date(at.getTime() + 30 * 60 * 1000) })
        .where(eq(sessions.id, row!.id));
      lastActor = await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
        now: () => at,
      });
      if (at.getTime() - createdAt.getTime() >= SESSION_ABSOLUTE_MAX_MS) {
        expect(lastActor).toBeNull();
      }
    }
    expect(lastActor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deactivation and soft deletion
// ---------------------------------------------------------------------------

describe("deactivated and deleted users", () => {
  it("refuses to mint a session for a deactivated user", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    await deactivateUser(h.db, user.id);

    const result = await h.signIn("a@x.test", PASSWORD);
    expect(result.cookie).toBeNull();
    expect(await sessionRowFor(user.id)).toBeUndefined();
  });

  it("invalidates existing sessions on deactivation", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    expect(
      await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
      }),
    ).not.toBeNull();

    await deactivateUser(h.db, user.id);

    expect(
      await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
      }),
    ).toBeNull();
  });

  it("invalidates existing sessions on soft deletion", async () => {
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    await softDeleteUser(h.db, user.id);

    expect(
      await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
      }),
    ).toBeNull();
  });

  it("denies a deactivated user even if a session row survives", async () => {
    // Defence in depth: the databaseHooks guard stops creation, but the helper
    // must independently refuse a session that already exists.
    const user = await h.createUser({ email: "a@x.test", password: PASSWORD });
    const { cookie } = await h.signIn("a@x.test", PASSWORD);
    await h.db
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(eq(users.id, user.id));

    expect(
      await getAuthenticatedActor({
        auth: h.auth,
        db: h.db,
        headers: h.headersFor(cookie!),
      }),
    ).toBeNull();
  });

  it("tombstones the email and resolves reuse to the active account only", async () => {
    const first = await h.createUser({ email: "a@x.test", password: PASSWORD });
    await softDeleteUser(h.db, first.id);

    const [deleted] = await h.db
      .select()
      .from(users)
      .where(eq(users.id, first.id));
    expect(deleted!.email).not.toBe("a@x.test");
    expect(deleted!.email).toContain(first.id);

    // The address is reusable, and a login resolves to the new account.
    const second = await h.createUser({
      email: "a@x.test",
      password: "a different password entirely",
    });
    const result = await h.signIn("a@x.test", "a different password entirely");
    expect(result.cookie).toBeTruthy();
    expect(await sessionRowFor(second.id)).toBeDefined();
    expect(await sessionRowFor(first.id)).toBeUndefined();

    // The old password must not work against the reused address.
    expect((await h.signIn("a@x.test", PASSWORD)).cookie).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Configuration invariants
// ---------------------------------------------------------------------------

describe("configuration invariants", () => {
  it("keeps cookie caching disabled", () => {
    // Enabling this would let a session be read from a signed cookie without a
    // database lookup, so revocation would stop working on the next request.
    expect(COOKIE_CACHE_ENABLED).toBe(false);
  });

  it("holds the session policy constants", () => {
    expect(SESSION_IDLE_SECONDS).toBe(1800);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(0);
    expect(SESSION_ABSOLUTE_MAX_MS).toBe(8 * 60 * 60 * 1000);
  });

  it("configures Better Auth with cookie cache off and the expected windows", async () => {
    const options = h.auth.options as {
      session?: {
        expiresIn?: number;
        updateAge?: number;
        cookieCache?: { enabled?: boolean };
      };
      emailAndPassword?: { disableSignUp?: boolean };
    };
    expect(options.session?.cookieCache?.enabled).toBe(false);
    expect(options.session?.expiresIn).toBe(SESSION_IDLE_SECONDS);
    expect(options.session?.updateAge).toBe(SESSION_UPDATE_AGE_SECONDS);
    expect(options.emailAndPassword?.disableSignUp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Password handling
// ---------------------------------------------------------------------------

describe("password handling", () => {
  it("produces Argon2id hashes that verify", async () => {
    const encoded = await hashPassword(PASSWORD);
    expect(encoded).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(encoded, PASSWORD)).toBe(true);
    expect(await verifyPassword(encoded, "wrong")).toBe(false);
  });

  it("salts, so identical passwords hash differently", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("treats a malformed hash as a failed verification, not an error", async () => {
    await expect(verifyPassword("not-a-hash", PASSWORD)).resolves.toBe(false);
  });

  it("normalizes email identifiers consistently", () => {
    expect(normalizeEmail("  A.User@Example.COM ")).toBe("a.user@example.com");
    expect(normalizeEmail("ａ@x.test")).toBe("a@x.test");
  });
});
