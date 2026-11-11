/** A host and the token that lets a client in: empty on a host without the token gate. */
export interface HostAddress {
  address: string;
  token: string;
}

/**
 * The host and token in the link `machines.phoneLink` makes: `eta://connect?address=…&token=…`.
 * `token` is absent on a host without the token gate. Anything else is not a link.
 */
export function parseConnectLink(text: string): HostAddress | undefined {
  const trimmed = text.trim();
  if (!/^eta:\/\/connect\?/i.test(trimmed)) return undefined;
  const query = new URLSearchParams(trimmed.slice(trimmed.indexOf("?") + 1));
  const address = query.get("address");
  if (address === null || address === "") return undefined;
  return { address, token: query.get("token") ?? "" };
}
