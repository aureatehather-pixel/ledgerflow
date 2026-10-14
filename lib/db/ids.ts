import { randomFillSync } from "node:crypto";

/**
 * UUIDv7 — time-ordered, so primary keys cluster by insertion time.
 *
 * data.md prefers v7 "where available for sortability". It matters most for the
 * two tables that grow without bound, `documents` and `audit_events`: random v4
 * keys scatter inserts across the whole B-tree, while v7 keeps them at the right
 * edge. That is an index-locality property, not a cosmetic one.
 *
 * Hand-rolled rather than taken as a dependency (standards.md: prefer the standard
 * library) -- it is the RFC 9562 layout in a dozen lines over node:crypto.
 *
 * Layout: 48 bits big-endian milliseconds | 4 bits version | 12 bits random
 *         | 2 bits variant | 62 bits random.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const millis = BigInt(Date.now());
  bytes[0] = Number((millis >> 40n) & 0xffn);
  bytes[1] = Number((millis >> 32n) & 0xffn);
  bytes[2] = Number((millis >> 24n) & 0xffn);
  bytes[3] = Number((millis >> 16n) & 0xffn);
  bytes[4] = Number((millis >> 8n) & 0xffn);
  bytes[5] = Number(millis & 0xffn);

  // Version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  // Non-null assertions: `bytes` is a fixed-length Uint8Array we just filled, so
  // these indices always exist. noUncheckedIndexedAccess cannot see that.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is shaped like a UUID.
 *
 * NOT a security control -- tenant predicates are. Two jobs, both mundane:
 * keep a malformed identifier from reaching the driver, where the resulting
 * error would be a differently-shaped response and therefore an enumeration
 * oracle; and keep a caller-supplied string out of a `uuid` column, where it
 * would turn a denial into an exception.
 *
 * Lives here because three call sites now need it -- authorization, upload and
 * audit. standards.md abstracts at the third use, not the second.
 */
export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}
