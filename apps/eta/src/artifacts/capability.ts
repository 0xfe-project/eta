/**
 * The capability in a preview address.
 *
 * The app shows an artifact in a sandboxed iframe, and a sandboxed iframe is an opaque origin: it
 * sends no cookie, and neither do the requests the page inside makes. So the token gate cannot
 * stand in front of a preview, and the address itself has to be the credential: `<version>.<expires>.
 * <signature>`, signed with a key that never leaves the host. It opens one version and nothing
 * else, and stops working after an hour. Every relative address of the page resolves under the same
 * capability, which is why it is a path segment and not a query.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** How long a preview address works. */
export const CAPABILITY_TTL_MS = 60 * 60 * 1000;

/** The signing key: made the first time (0600), read every time after. */
export function loadKey(path: string): Buffer {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return readFileSync(path);
}

const signatureOf = (key: Buffer, body: string): string =>
  createHmac("sha256", key).update(body).digest("base64url");

/** A capability to open one version until `expiresAt` (epoch milliseconds). */
export function sign(
  key: Buffer,
  versionId: string,
  expiresAt: number,
): string {
  const body = `${versionId}.${expiresAt}`;
  return `${body}.${signatureOf(key, body)}`;
}

/**
 * The version a capability opens, or nothing: forged, altered, expired and malformed are all the
 * same answer, because a stranger should not learn which.
 */
export function verify(
  key: Buffer,
  capability: string,
  now: number,
): string | undefined {
  const parts = capability.split(".");
  if (parts.length !== 3) return undefined;
  const [versionId, expires, signature] = parts as [string, string, string];
  if (!/^\d{1,16}$/.test(expires) || Number(expires) < now) return undefined;
  const expected = Buffer.from(signatureOf(key, `${versionId}.${expires}`));
  const given = Buffer.from(signature);
  // Equal lengths first: `timingSafeEqual` throws on unequal ones.
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? versionId
    : undefined;
}
