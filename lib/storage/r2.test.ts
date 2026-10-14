import { describe, expect, it } from "vitest";

import { documentStorageKey } from "./index";
import { createR2Store, StorageError } from "./r2";

/**
 * UNIT tests for the R2 adapter, against an injected `fetch`.
 *
 * These prove request CONSTRUCTION — endpoint, method, path, headers, signing,
 * status handling. **They are not integration tests and no passing result here
 * says R2 works.** The live smoke test (`npm run storage:smoke`) is the only
 * evidence of that.
 *
 * The credentials below are obvious fakes and never leave this process.
 */

const CONFIG = {
  accountId: "abc123account",
  accessKeyId: "AKIAFAKEFAKEFAKE",
  secretAccessKey: "fake-secret-value-not-real-0000000000000000",
  bucket: "ledgerflow-test",
};

/** Captures the signed Request instead of sending it. */
function captureFetch(response: Response = new Response(null, { status: 200 })) {
  const calls: Request[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(input as Request);
    return response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const KEY = documentStorageKey({
  firmId: "11111111-1111-7111-8111-111111111111",
  clientId: "22222222-2222-7222-8222-222222222222",
  documentId: "33333333-3333-7333-8333-333333333333",
});

describe("request construction", () => {
  it("PUTs to the account endpoint, bucket and exact key", async () => {
    const { impl, calls } = captureFetch();
    await createR2Store(CONFIG, impl).put(KEY, new Uint8Array([1, 2, 3]), "application/pdf");

    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      `https://${CONFIG.accountId}.r2.cloudflarestorage.com/${CONFIG.bucket}/${KEY}`,
    );
    expect(request.headers.get("content-type")).toBe("application/pdf");
  });

  it("DELETEs the same URL with no body", async () => {
    const { impl, calls } = captureFetch(new Response(null, { status: 204 }));
    await createR2Store(CONFIG, impl).delete(KEY);

    const request = calls[0]!;
    expect(request.method).toBe("DELETE");
    expect(request.url).toContain(`/${CONFIG.bucket}/${KEY}`);
  });

  it("delegates signing to aws4fetch", async () => {
    const { impl, calls } = captureFetch();
    await createR2Store(CONFIG, impl).put(KEY, new Uint8Array([1]), "application/pdf");

    const auth = calls[0]!.headers.get("authorization") ?? "";
    // SigV4, service s3, region auto -- produced by aws4fetch, not by us.
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("/auto/s3/aws4_request");
    expect(auth).toContain(CONFIG.accessKeyId);
    // The signature is derived from the secret; the secret itself is never sent.
    expect(auth).not.toContain(CONFIG.secretAccessKey);
    expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeTruthy();
  });

  it("never lets a caller-supplied filename reach the object key", async () => {
    const { impl, calls } = captureFetch();
    // The key is built only from UUIDs; a filename has no route into it. This
    // pins that at the adapter boundary as well as at construction.
    await createR2Store(CONFIG, impl).put(KEY, new Uint8Array([1]), "application/pdf");

    const url = calls[0]!.url;
    expect(url).not.toContain("statement");
    expect(url).not.toContain("..");
    expect(url).not.toContain("%2e%2e");
    expect(url.endsWith(KEY)).toBe(true);
  });

  it("sends the exact bytes given", async () => {
    const { impl, calls } = captureFetch();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    await createR2Store(CONFIG, impl).put(KEY, bytes, "application/pdf");

    const body = new Uint8Array(await calls[0]!.arrayBuffer());
    expect([...body]).toEqual([...bytes]);
  });
});

describe("status handling", () => {
  it.each([200, 201, 204])("accepts a %d on put", async (status) => {
    const { impl } = captureFetch(new Response(null, { status }));
    await expect(
      createR2Store(CONFIG, impl).put(KEY, new Uint8Array([1]), "application/pdf"),
    ).resolves.toBeUndefined();
  });

  it.each([200, 202, 204, 404])("accepts a %d on delete", async (status) => {
    // 404 included on purpose: S3-compatible delete is idempotent, and deleting
    // an object that is already gone is exactly what compensation wants.
    const { impl } = captureFetch(new Response(null, { status }));
    await expect(createR2Store(CONFIG, impl).delete(KEY)).resolves.toBeUndefined();
  });

  it.each([400, 401, 403, 500, 503])(
    "normalises a %d on put into StorageError",
    async (status) => {
      const { impl } = captureFetch(new Response("<Error/>", { status }));
      await expect(
        createR2Store(CONFIG, impl).put(KEY, new Uint8Array([1]), "application/pdf"),
      ).rejects.toBeInstanceOf(StorageError);
    },
  );

  it.each([400, 403, 500])(
    "normalises a %d on delete into StorageError",
    async (status) => {
      const { impl } = captureFetch(new Response(null, { status }));
      await expect(createR2Store(CONFIG, impl).delete(KEY)).rejects.toBeInstanceOf(
        StorageError,
      );
    },
  );

  it("normalises a transport failure", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED 1.2.3.4:443");
    }) as unknown as typeof fetch;
    const error = await createR2Store(CONFIG, impl)
      .put(KEY, new Uint8Array([1]), "application/pdf")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).status).toBeUndefined();
  });
});

describe("errors carry no secret material", () => {
  it("omits credentials, signature and response body", async () => {
    const { impl } = captureFetch(
      // A response body that echoes request detail, as S3 error XML does.
      new Response(
        `<Error><Message>${CONFIG.accessKeyId} denied</Message></Error>`,
        { status: 403 },
      ),
    );
    const error = (await createR2Store(CONFIG, impl)
      .put(KEY, new Uint8Array([1]), "application/pdf")
      .catch((e: unknown) => e)) as StorageError;

    const dump = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
    expect(dump).not.toContain(CONFIG.secretAccessKey);
    expect(dump).not.toContain(CONFIG.accessKeyId);
    expect(dump).not.toContain("AWS4-HMAC-SHA256");
    expect(dump).not.toContain("denied"); // the response body is never included
    // What it does carry: enough to act on.
    expect(error.message).toContain("403");
    expect(error.operation).toBe("put");
    expect(error.key).toBe(KEY);
  });

  it("omits the underlying cause on a transport error", async () => {
    const impl = (async () => {
      throw new Error(`connect failed using key ${CONFIG.secretAccessKey}`);
    }) as unknown as typeof fetch;
    const error = (await createR2Store(CONFIG, impl)
      .delete(KEY)
      .catch((e: unknown) => e)) as StorageError;

    const dump = `${error.message} ${error.stack ?? ""} ${String(error.cause ?? "")}`;
    expect(dump).not.toContain(CONFIG.secretAccessKey);
  });
});
