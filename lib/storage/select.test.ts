import { describe, expect, it } from "vitest";

import { selectObjectStore } from "./select";

/**
 * Storage selection must fail closed.
 *
 * The failure this guards against is a production deployment quietly writing a
 * firm's documents into a process that forgets them on restart. That would look
 * like a working system until the first restart, and the documents would be
 * unrecoverable. Refusing to start is strictly better.
 */
describe("object store selection", () => {
  it("refuses to run with no storage configuration", () => {
    expect(() => selectObjectStore({})).toThrow(/not configured/);
  });

  it("names the missing variables without revealing any value", () => {
    let message = "";
    try {
      selectObjectStore({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "super-secret-key-id",
        R2_SECRET_ACCESS_KEY: "super-secret-value",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("R2_BUCKET");
    // The point of the assertion: names leak nothing, values would.
    expect(message).not.toContain("super-secret-key-id");
    expect(message).not.toContain("super-secret-value");
    expect(message).not.toContain("acct");
  });

  it("returns the R2 adapter when fully configured, never an in-memory one", () => {
    const store = selectObjectStore({
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
      R2_BUCKET: "d",
    });
    // The port exposes exactly two methods, and this must not be the test fake:
    // a memory store carries `objects`, `putCount` and `deleteCount`.
    expect(typeof store.put).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(store).not.toHaveProperty("objects");
    expect(store).not.toHaveProperty("putCount");
  });

  it.each([
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ])("fails closed when %s alone is missing", (missing) => {
    const env: Record<string, string> = {
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "b",
      R2_SECRET_ACCESS_KEY: "c",
      R2_BUCKET: "d",
    };
    delete env[missing];
    expect(() => selectObjectStore(env)).toThrow(new RegExp(missing));
  });
});
