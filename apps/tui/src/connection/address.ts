/** Host addresses as the user types them, and the forms the connection uses. */

const SCHEME = /^([a-z][\d+.a-z-]*):\/\//i;

/** What each scheme the user may type means as an HTTP base. */
const HTTP_SCHEME: Record<string, "http:" | "https:"> = {
  http: "http:",
  https: "https:",
  ws: "http:",
  wss: "https:",
};

/**
 * The HTTP base `http(s)://host[:port]` of an address the user gave: no scheme means http,
 * `ws` and `wss` mean http and https, and any path, query or fragment is dropped. Undefined for
 * another scheme or an address without a host.
 */
export function normalizeAddress(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  const protocol = scheme === undefined ? "http:" : HTTP_SCHEME[scheme];
  if (protocol === undefined) return undefined;
  const rest =
    scheme === undefined ? trimmed : trimmed.slice(scheme.length + 3);
  // The URL parser skips extra slashes and would take `https:///path` as the host `path`.
  if (rest === "" || rest.startsWith("/") || rest.startsWith("\\"))
    return undefined;
  let url: URL;
  try {
    url = new URL(`${protocol}//${rest}`);
  } catch {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  // A user name has no place in a host's base, and `mailto:me@host` would otherwise read as one.
  if (url.username !== "" || url.password !== "") return undefined;
  return `${url.protocol}//${url.host}`;
}

/** Whether an HTTP base names this computer: `localhost`, `127.x.x.x` or `[::1]`. */
export function isLoopback(base: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/** The host's socket for an HTTP base: `ws(s)://host[:port]/ws`. */
export function wireUrl(base: string): string {
  return `${base.replace(/^http/, "ws")}/ws`;
}
