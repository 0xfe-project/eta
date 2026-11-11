/**
 * What runs in a page before its own first line, and the way a secure page reaches the bridge.
 *
 * The facts hold the bridge's token, so they go to one page: the top frame of the origin the
 * window was given. Electrobun runs a preload in whatever a webview navigates to, and neither a
 * site the window wandered to nor an artifact's preview frame is that page.
 *
 * An `https` page cannot call the bridge: WebKit refuses it as mixed content, `127.0.0.1` or not,
 * and a host behind `tailscale serve` would lose its window buttons and links. Electrobun's own
 * message channel to this process is not a web request, so such a page's `fetch` to the bridge goes
 * through that, and `relayToBridge` makes the same request here. The page's code does not know,
 * so it works for a host of any version, and the bridge stays the one place that answers. A relayed
 * request has no `Origin`; what stands in for it is the token, which only the page above has.
 */

interface PreloadOptions {
  /** `window.__ETA_HOST__`; `nativeApiBase` and `nativeToken` are the bridge's. */
  facts: { nativeApiBase: string; nativeToken: string } & Record<
    string,
    unknown
  >;
  /** The page's origin; a page without one (`views://`) is only known by being on top. */
  origin: string | undefined;
  /** The token of the connection calls, for the shell's own page. */
  shellToken?: string;
}

export function pagePreload({ facts, origin, shellToken }: PreloadOptions) {
  const ours =
    origin === undefined
      ? "window === window.top"
      : `window === window.top && location.origin === ${JSON.stringify(origin)}`;
  return `if (${ours}) {
  const facts = ${JSON.stringify(facts)};
  window.__ETA_HOST__ = facts;
  ${shellToken === undefined ? "" : `window.__ETA_SHELL__ = ${JSON.stringify({ token: shellToken })};`}
  if (location.protocol === "https:") {
    const base = facts.nativeApiBase + "/";
    const direct = window.fetch.bind(window);
    const waiting = new Map();
    let last = 0;
    window.__etaBridgeAnswer = (id, status, body) => {
      waiting.get(id)?.(new Response(status === 202 ? null : body, { status }));
      waiting.delete(id);
    };
    window.fetch = (input, init) => {
      if (typeof input !== "string" || !input.startsWith(base)) return direct(input, init);
      return new Promise((resolve) => {
        last += 1;
        waiting.set(last, resolve);
        window.__electrobunSendToHost({
          etaBridge: last,
          path: input.slice(facts.nativeApiBase.length),
          method: init?.method ?? "GET",
          body: init?.body,
          token: facts.nativeToken,
        });
      });
    };
  }
}`;
}

interface RelayedRequest {
  id: number;
  path: string;
  method: string;
  body: string | undefined;
  token: string;
}

/** A `host-message` that is a page's bridge call, or nothing: anyone can send one. */
export function relayedRequest(message: unknown): RelayedRequest | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { body, etaBridge, method, path, token } = message as Record<
    string,
    unknown
  >;
  if (
    typeof etaBridge !== "number" ||
    typeof path !== "string" ||
    !path.startsWith("/api/native/") ||
    (method !== "GET" && method !== "POST") ||
    typeof token !== "string" ||
    (body !== undefined && typeof body !== "string")
  )
    return undefined;
  return { id: etaBridge, path, method, body, token };
}

/** The same request the page would have made, for what the page's `fetch` should resolve with. */
export async function relayToBridge(
  apiBase: string,
  request: RelayedRequest,
): Promise<string> {
  const answer = await fetch(`${apiBase}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${request.token}`,
      "content-type": "application/json",
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const text = await answer.text();
  return `window.__etaBridgeAnswer?.(${String(request.id)}, ${String(answer.status)}, ${JSON.stringify(text)});`;
}
