/**
 * The migration entry point: `npm run db:migrate`.
 *
 * Applies every pending numbered SQL migration to the database named by
 * DATABASE_URL. Safe to run repeatedly and safe to run concurrently — an
 * advisory lock serialises deployers and the ledger's primary key is the
 * backstop.
 */
import { join } from "node:path";

import { Client } from "@neondatabase/serverless";

import { nodePostgresExecutor } from "../lib/db/executors.ts";
import { migrate } from "../lib/db/migrator.ts";

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    // Fail loud. A default connection string is how a development database
    // ends up being migrated instead of the intended one.
    throw new Error("DATABASE_URL is not set");
  }

  // The WebSocket client, not neon-http: migrations need one session for the
  // advisory lock and for transactions to span statements.
  const client = new Client(url);

  // A failed handshake is delivered TWICE: once as the promise awaited below,
  // and once as an `error` event on the client. With no listener attached, Node
  // throws the second one from `process.nextTick`, killing the process *before*
  // main().catch can print anything -- the operator gets kilobytes of driver
  // stack and not one word about what went wrong. Verified 2026-07-31 against a
  // deliberately invalid credential: 2832 bytes of stack, and the words
  // "password authentication failed" nowhere in it.
  //
  // This is not a swallowed error. The authoritative failure still arrives as a
  // rejection, is still reported, and still exits non-zero. The listener only
  // stops a duplicate from being fatal, and it announces itself so a genuinely
  // unexpected socket error is never silent.
  client.on("error", (cause: unknown) => {
    // ASCII only: this stream is read in Windows consoles, where a non-ASCII
    // dash renders as mojibake. The rest of the migrator's output is ASCII too.
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? ` (${String((cause as Record<string, unknown>)["code"])})`
        : "";
    console.error(
      `[migrate] secondary connection error${code}; the failure reported below is the authoritative one`,
    );
  });

  await client.connect();
  try {
    const result = await migrate(
      nodePostgresExecutor(client),
      join(process.cwd(), "lib", "db", "migrations"),
      (message) => console.error(`[migrate] ${message}`),
    );
    console.error(
      `[migrate] done. applied=${result.applied.length} skipped=${result.skipped.length}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
