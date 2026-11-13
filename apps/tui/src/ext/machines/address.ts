// The address a new machine is told to dial.

import { isLoopbackHostname, originOf } from "../kit/connection";

/**
 * The address a new machine is told to dial: the host's tailnet address when it has one, else the
 * address this terminal reaches the host at unless that is loopback (another machine cannot dial
 * it), else undefined, which leaves the choice to the host.
 */
export function enrollUrl(input: {
  tailnet: string | null;
  connectionUrl: string | undefined;
}): string | undefined {
  if (input.tailnet !== null) return input.tailnet;
  const origin = originOf(input.connectionUrl);
  if (origin === undefined || origin === "null") return undefined;
  return isLoopbackHostname(new URL(origin).hostname) ? undefined : origin;
}
