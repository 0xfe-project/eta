// Where this terminal reaches the host, for what is handed to something outside it: a browser
// coming back from a sign-in, a new machine dialing in, an editor opened on the host's files.

import type { ConnectionController } from "../../connection/types";

const LOOPBACK_NAMES = new Set(["localhost", "[::1]"]);
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The address this terminal reaches the host at; undefined while there is none. */
export function connectionUrl(
  connection: ConnectionController,
): string | undefined {
  const { phase } = connection.getState();
  return phase.name === "connected" ||
    phase.name === "connecting" ||
    phase.name === "reconnecting"
    ? phase.url
    : undefined;
}

/** The origin of `connectionUrl`. */
export function connectionOrigin(
  connection: ConnectionController,
): string | undefined {
  return originOf(connectionUrl(connection));
}

/** The origin of an address; undefined for none or one that does not parse. */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Whether a URL's `hostname` names this computer: `localhost`, `[::1]` or `127.0.0.0/8`. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || IPV4_LOOPBACK.test(hostname);
}
