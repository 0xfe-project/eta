/**
 * Quick looks at an address over HTTP. The host's gate leaves `/up` open and guards `/ws`
 * (`apps/eta/src/access.ts`), so `/up` says whether a host is there and a plain GET of `/ws`
 * says whether the token gets past the gate: 401 if not, anything else (a refused upgrade,
 * typically 400) if so.
 */
import type { AddressCheck } from "./types";
import { normalizeAddress } from "./address";

const UNAUTHORIZED = 401;

/** Whether a host answers `GET <base>/up` with 200 `ok` within the timeout. */
export async function probeUp(
  base: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(`${base}/up`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status === 200 && (await response.text()) === "ok";
  } catch {
    return false;
  }
}

export type TokenProbe = "pass" | "unauthorized" | "unreachable";

/** What the gate of `<base>/ws` says to the token (or to no token). */
export async function probeToken(
  base: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<TokenProbe> {
  try {
    const response = await fetch(`${base}/ws`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status === UNAUTHORIZED ? "unauthorized" : "pass";
  } catch {
    return "unreachable";
  }
}

/**
 * Normalise an address and look at it: without a token first, and with the token only when the
 * host asks for one.
 */
export async function checkAddress(
  address: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<AddressCheck> {
  const url = normalizeAddress(address);
  if (url === undefined) return { result: "invalid" };
  const open = await probeToken(url, undefined, timeoutMs);
  if (open === "unreachable") return { result: "unreachable", url };
  if (open === "pass") return { result: "ok", url };
  if (token === undefined) return { result: "needs-token", url };
  const withToken = await probeToken(url, token, timeoutMs);
  if (withToken === "pass") return { result: "ok", url };
  if (withToken === "unauthorized") return { result: "bad-token", url };
  return { result: "unreachable", url };
}
