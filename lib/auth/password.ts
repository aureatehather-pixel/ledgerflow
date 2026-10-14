import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id password hashing.
 *
 * Parameters follow OWASP's current floor: 19 MiB memory, 2 iterations,
 * parallelism 1. They are encoded into the hash string itself, so raising them
 * later re-hashes new passwords without invalidating existing ones.
 */
const ARGON2_OPTIONS = {
  // 2 = Argon2id. The Algorithm enum is an ambient const enum, which
  // isolatedModules forbids importing; the numeric value is the stable wire
  // form the library itself uses.
  algorithm: 2,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** A hash of a value no user can supply, used to spend comparable work when the
 *  account does not exist. Computed once at module load, not per request. */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash(
    "unknown-user-placeholder-never-a-real-password",
    ARGON2_OPTIONS,
  );
  return dummyHashPromise;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  encodedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(encodedHash, password, ARGON2_OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an
    // error the caller might treat differently -- a distinguishable failure is
    // an oracle.
    return false;
  }
}

/**
 * Spends roughly the work a real verification would, for a login attempt against
 * an address with no account.
 *
 * This narrows the timing gap between "no such user" and "wrong password". It
 * does NOT make them indistinguishable: database lookup time, scheduling and
 * network jitter all still differ, and no unit test can demonstrate otherwise.
 * Treat it as proportionate mitigation for M1, not as timing-attack resistance.
 */
export async function spendDummyVerification(password: string): Promise<void> {
  await verifyPassword(await getDummyHash(), password);
}
