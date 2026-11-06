/**
 * The one token eta keeps: what the user typed into the settings, for a host where the environment
 * and `gh` cannot help, as when a service is out of reach of the keychain.
 *
 * It is sealed under the host's key (`../secret`), in the `setting` table, so a backup of the
 * database does not carry it in the clear. It is kept with the host it was saved for, because the
 * upstream can change afterwards, and only that host is ever sent it. The page learns the host and
 * never gets the token back.
 */
import { Buffer } from "node:buffer";
import { seal, unseal } from "../secret";

export const TOKEN_SETTING = "upgrade.token";

/** How a saved token is named as a source (`ReleaseToken.from`). */
export const SAVED_TOKEN = "Settings";

/** Printable, one word: anything else would break a header, or was not a token. */
const TOKEN = /^[\x21-\x7E]+$/;

export interface SavedToken {
  /** The host it may go to, as `gh` would call it. */
  host: string;
  token: string;
}

interface StoredToken {
  host: string;
  /** `seal`'s blob, in base64. */
  sealed: string;
}

const isStored = (value: unknown): value is StoredToken =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredToken).host === "string" &&
  typeof (value as StoredToken).sealed === "string";

/** The token as typed, without what a paste brings along. Never repeats it when it refuses. */
export function cleanToken(given: string): string {
  const token = given.trim();
  if (!TOKEN.test(token))
    throw new Error(
      "that is not a token: it should be one word, with no spaces",
    );
  return token;
}

export const sealToken = (
  key: Buffer,
  { host, token }: SavedToken,
): StoredToken => ({ host, sealed: seal(key, token).toString("base64") });

/** The host a stored token is for; undefined when nothing usable is stored. */
export const tokenHost = (stored: unknown): string | undefined =>
  isStored(stored) ? stored.host : undefined;

/** The token and its host; undefined for what does not open under this key. */
export function openToken(
  key: Buffer,
  stored: unknown,
): SavedToken | undefined {
  if (!isStored(stored)) return undefined;
  const { host, sealed } = stored;
  const token = unseal(key, Buffer.from(sealed, "base64"));
  return token === undefined ? undefined : { host, token };
}
