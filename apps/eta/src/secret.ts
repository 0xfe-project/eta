/**
 * Sealing: what the host stores secrets as (a bundle's configuration, MCP OAuth credentials).
 *
 * AES-256-GCM under the host's key. The key is a file next to the database that never leaves the
 * host, so the database can be copied, backed up or read by a tool without the values in it
 * being readable. A blob that does not open (another host's key, or tampering) reads as nothing.
 */
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadKey } from "./artifacts/capability";

/** The host's key: `<dataDir>/secret.key`, 32 random bytes made (0600) the first time. */
export const loadSecretKey = (dataDir: string): Buffer =>
  loadKey(join(dataDir, "secret.key"));

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** `iv | tag | ciphertext`. */
export function seal(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The text a blob holds, or `undefined` when it does not open under this key. */
export function unseal(key: Buffer, sealed: Uint8Array): string | undefined {
  const blob = Buffer.from(sealed);
  if (blob.length < IV_LENGTH + TAG_LENGTH) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      blob.subarray(0, IV_LENGTH),
    );
    decipher.setAuthTag(blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    return Buffer.concat([
      decipher.update(blob.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}
