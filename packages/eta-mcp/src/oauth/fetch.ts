// Refresh tokens rotate, so two concurrent refreshes of one token would make the second fail with
// invalid_grant and (via the SDK) wipe the credentials. This wrapper lets concurrent token
// requests for the same refresh token share one network request.
// Adapted from opencode's `send`/`refreshKey` (packages/core/src/mcp/oauth.ts, MIT, (c) 2025 opencode).
import type { FetchLike } from "@modelcontextprotocol/client";

function refreshKey(
  url: string | URL,
  init: RequestInit | undefined,
): string | undefined {
  const body = init?.body;
  let params: URLSearchParams;
  if (body instanceof URLSearchParams) params = body;
  else if (typeof body === "string") params = new URLSearchParams(body);
  else return undefined;
  if (params.get("grant_type") !== "refresh_token") return undefined;
  return [
    String(url),
    params.get("client_id") ?? "",
    params.get("refresh_token") ?? "",
  ].join("\0");
}

/** Wrap `base` (default: global fetch). Keep one wrapper per process so all servers share the map. */
export function createRefreshDedupingFetch(base: FetchLike = fetch): FetchLike {
  const inflight = new Map<string, ReturnType<FetchLike>>();
  // Each caller reads its own copy of the body.
  const share = (pending: ReturnType<FetchLike>) =>
    pending.then((response) => response.clone() as typeof response);
  return (url, init) => {
    const key = refreshKey(url, init);
    if (key === undefined) return base(url, init);
    const current = inflight.get(key);
    if (current) return share(current);
    const pending = base(url, init).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
    return share(pending);
  };
}
