/**
 * Who this daemon is to its primary: the address it dials, the machine id the primary gave it and
 * the secret it made for itself. The secret is the only credential the daemon holds, so the file
 * is 0600 in a 0700 directory, and the primary never learns it (it keeps a digest).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Identity {
  /** The primary's address, `http(s)://host:port`. */
  url: string;
  machineId: string;
  secret: string;
}

export const defaultDataDir = (): string => join(homedir(), ".eta-daemon");

const identityPath = (dataDir: string): string =>
  join(dataDir, "identity.json");

/** A new secret, and the fingerprint both ends show for it. */
export function newSecret(): { secret: string; fingerprint: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, fingerprint: fingerprintOf(secret) };
}

export function fingerprintOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Eight-character groups, for a person to compare by eye. */
export function groupFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,8}/g) ?? []).join(" ");
}

export function saveIdentity(dataDir: string, identity: Identity): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  writeFileSync(identityPath(dataDir), JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });
  chmodSync(identityPath(dataDir), 0o600);
}

export function loadIdentity(dataDir: string): Identity | undefined {
  const path = identityPath(dataDir);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Identity>;
  if (
    typeof value.url !== "string" ||
    typeof value.machineId !== "string" ||
    typeof value.secret !== "string"
  )
    throw new Error(`${path} is not a daemon identity`);
  return { url: value.url, machineId: value.machineId, secret: value.secret };
}
