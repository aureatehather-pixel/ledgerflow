import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthenticatedActor } from "@/lib/auth/session";
import { createAuthHarness, type AuthHarness } from "@/lib/auth/testing";
import { clientAssignments, clients, documents } from "@/lib/db/schema";
import { documentStorageKey } from "@/lib/storage";
import { headObject, listObjectKeys, r2ConfigFromEnv } from "@/lib/storage/r2-inspect";
import { createR2Store, StorageError, type R2Config } from "@/lib/storage/r2";
import { selectObjectStore } from "@/lib/storage/select";
import { uploadDocument } from "@/lib/upload";

/**
 * LIVE R2 smoke test. Opt-in: `npm run storage:smoke`. Never runs in `npm test`.
 *
 * Hits a real, private, development-only bucket with synthetic documents. Every
 * object it creates is recorded and removed in `afterAll`, which runs even when
 * assertions fail — an aborted run must not leave paid storage behind.
 *
 * Cost discipline: three tiny objects total (~40 bytes each), because three is
 * the minimum that covers upload/verify/delete, compensation-on-failure, and
 * compensation-that-itself-fails.
 *
 * No credential value is ever printed. Lengths and booleans only.
 */

const PASSWORD = "correct horse battery staple";
const PREFIX = `smoke-${Date.now()}`;

/** A genuinely well-formed minimal PDF, ~40 bytes. */
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

let config: R2Config;
let h: AuthHarness;
/** Everything we create, so cleanup can be exhaustive rather than hopeful. */
const created: string[] = [];
const evidence: string[] = [];

function record(line: string) {
  evidence.push(line);
}

beforeAll(async () => {
  config = r2ConfigFromEnv();
  h = await createAuthHarness();
});

afterAll(async () => {
  // Cleanup runs regardless of outcome.
  const store = createR2Store(config);
  const failures: string[] = [];
  for (const key of created) {
    try {
      await store.delete(key);
    } catch (error) {
      failures.push(`${key}: ${(error as Error).message}`);
    }
  }
  const remaining: string[] = [];
  for (const key of created) {
    if ((await headObject(config, key)) !== null) remaining.push(key);
  }

  const listed = await listObjectKeys(config, PREFIX);
  record(
    `CLEANUP: attempted=${created.length} deleteErrors=${failures.length} ` +
      `stillPresent=${remaining.length}`,
  );
  record(
    listed === null
      ? `FINAL COUNT under "${PREFIX}": LIST NOT PERMITTED by token; ` +
          `verified via HEAD on ${created.length} known keys -> ${remaining.length} remaining`
      : `FINAL COUNT under "${PREFIX}" via LIST: ${listed.length}`,
  );

  await h.close();

  console.error("\n===== SMOKE EVIDENCE =====\n" + evidence.join("\n") + "\n");

  if (remaining.length > 0 || failures.length > 0) {
    throw new Error(
      `Cleanup incomplete. remaining=${JSON.stringify(remaining)} errors=${JSON.stringify(failures)}`,
    );
  }
  if (listed !== null && listed.length > 0) {
    throw new Error(`Bucket not clean: ${listed.length} objects under ${PREFIX}`);
  }
});

/** A smoke-scoped key, so nothing collides with other bucket contents. */
function smokeKey(name: string): string {
  const key = `${PREFIX}/${documentStorageKey({
    firmId: "11111111-1111-7111-8111-111111111111",
    clientId: "22222222-2222-7222-8222-222222222222",
    documentId: `33333333-3333-7333-8333-${name.padStart(12, "0")}`,
  })}`;
  created.push(key);
  return key;
}

// ---------------------------------------------------------------------------

describe("live R2", () => {
  it("1. loads configuration without exposing values", () => {
    expect(config.accountId.length).toBeGreaterThan(0);
    expect(config.bucket.length).toBeGreaterThan(0);
    record(
      `CONFIG: accountId=${config.accountId.length} chars, ` +
        `accessKeyId=${config.accessKeyId.length} chars, ` +
        `secretAccessKey=${config.secretAccessKey.length} chars, ` +
        `bucket="${config.bucket}"`,
    );
    // Selection returns the real adapter, not the test fake.
    const store = selectObjectStore(process.env);
    expect(store).not.toHaveProperty("objects");
    record("SELECT: production adapter chosen (no in-memory fallback)");
  });

  it("2-7. uploads, verifies, and deletes a synthetic PDF", async () => {
    const store = createR2Store(config);
    const key = smokeKey("a");

    await store.put(key, PDF, "application/pdf");
    record(`PUT: ok key=${key}`);

    const meta = await headObject(config, key);
    expect(meta).not.toBeNull();
    record(
      `HEAD: exists=true contentLength=${meta!.contentLength} ` +
        `contentType=${meta!.contentType}`,
    );

    // 3. exact server-generated key shape
    expect(key.endsWith(
      "firms/11111111-1111-7111-8111-111111111111/" +
        "clients/22222222-2222-7222-8222-222222222222/" +
        "documents/33333333-3333-7333-8333-00000000000a",
    )).toBe(true);
    // 5. byte length round-trips
    expect(meta!.contentLength).toBe(PDF.length);
    // 6. content type round-trips
    expect(meta!.contentType).toBe("application/pdf");

    // 7. deletion removes it
    await store.delete(key);
    expect(await headObject(config, key)).toBeNull();
    record("DELETE: ok, object absent afterwards");

    // 8. repeated deletion is idempotent
    await expect(store.delete(key)).resolves.toBeUndefined();
    record("DELETE (repeat, absent object): treated as success — idempotent");
  });

  it("9. normalises denied credentials without leaking secrets", async () => {
    const wrong = createR2Store({ ...config, secretAccessKey: "x".repeat(64) });
    const key = `${PREFIX}/denied-probe`;

    const error = (await wrong
      .put(key, PDF, "application/pdf")
      .catch((e: unknown) => e)) as StorageError;

    expect(error).toBeInstanceOf(StorageError);
    record(`DENIED CREDENTIALS: ${error.name} status=${error.status ?? "transport"}`);

    const dump = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
    expect(dump).not.toContain(config.secretAccessKey);
    expect(dump).not.toContain(config.accessKeyId);
    record("DENIED CREDENTIALS: error contains no key id and no secret");

    // Nothing was written, so nothing needs cleaning up.
    expect(await headObject(config, key)).toBeNull();
  });

  it("10. a forced finalisation failure triggers a real R2 delete", async () => {
    const s = await seedUploadable();
    const store = createR2Store(config);
    let uploadedKey = "";
    const observing = {
      put: async (k: string, b: Uint8Array, c: string) => {
        uploadedKey = k;
        created.push(k);
        await store.put(k, b, c);
      },
      delete: (k: string) => store.delete(k),
    };

    const result = await uploadDocument(
      { db: brokenFinalization(h.db), store: observing },
      s.actor,
      {
        clientId: s.clientId,
        filename: "statement.pdf",
        declaredType: "application/pdf",
        bytes: PDF,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "FINALIZATION_FAILED",
      orphanObjectRemoved: true,
    });
    // The compensation happened against real R2, not a fake.
    expect(await headObject(config, uploadedKey)).toBeNull();
    record(`COMPENSATION: object removed from R2 after finalisation failure`);

    const [row] = await h.db
      .select()
      .from(documents)
      .where(eq(documents.clientId, s.clientId));
    expect(row!.status).toBe("failed");
    record("COMPENSATION: row=failed, invisible");
  });

  it("11. a failed compensation leaves a failed row with a recoverable key", async () => {
    const s = await seedUploadable("second");
    const store = createR2Store(config);
    let uploadedKey = "";
    const brokenDelete = {
      put: async (k: string, b: Uint8Array, c: string) => {
        uploadedKey = k;
        created.push(k); // afterAll must still remove it
        await store.put(k, b, c);
      },
      delete: async () => {
        throw new Error("simulated delete failure");
      },
    };

    const result = await uploadDocument(
      { db: brokenFinalization(h.db), store: brokenDelete },
      s.actor,
      {
        clientId: s.clientId,
        filename: "statement.pdf",
        declaredType: "application/pdf",
        bytes: PDF,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "FINALIZATION_FAILED",
      orphanObjectRemoved: false,
    });
    // The object really is still in R2 — that is the point of the flag.
    expect(await headObject(config, uploadedKey)).not.toBeNull();

    const [row] = await h.db
      .select()
      .from(documents)
      .where(eq(documents.clientId, s.clientId));
    expect(row!.status).toBe("failed");
    expect(row!.storageKey).toBe(uploadedKey);
    record(
      "FAILED COMPENSATION: orphanObjectRemoved=false, row=failed, " +
        "storage key recorded and object confirmed present in R2",
    );
  });
});

// ---------------------------------------------------------------------------

/** A firm, client and write-assigned user, with a smoke-prefixed storage key. */
async function seedUploadable(suffix = "first") {
  const [client] = await h.db
    .insert(clients)
    .values({ firmId: h.firm.id, name: `Smoke ${suffix}`, code: `SMK-${suffix}` })
    .returning();
  const user = await h.createUser({
    email: `smoke-${suffix}@x.test`,
    password: PASSWORD,
  });
  await h.db.insert(clientAssignments).values({
    userId: user.id,
    clientId: client!.id,
    accessLevel: "write",
  });
  const actor: AuthenticatedActor = {
    userId: user.id,
    firmId: h.firm.id,
    email: user.email,
    firmRole: "staff",
    sessionId: "00000000-0000-7000-8000-000000000000",
    sessionCreatedAt: new Date(),
  };
  return { actor, clientId: client!.id };
}

/** Breaks only the finalising UPDATE, leaving markFailed working. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function brokenFinalization(db: any) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const real = (target as any).update.bind(target);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (table: any) => {
          const builder = real(table);
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            set: (values: any) => {
              const afterSet = builder.set(values);
              return {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                where: (cond: any) =>
                  Object.assign(afterSet.where(cond), {
                    returning: () => {
                      throw new Error("connection lost");
                    },
                  }),
              };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
