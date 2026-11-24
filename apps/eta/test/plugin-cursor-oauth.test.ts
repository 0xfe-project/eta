/**
 * A Cursor-hosted server the user gave a Cursor credential (x-cursor-auth) and then signed in to with
 * the service's own OAuth (Google): both layers reach the server, in the connection test and in the
 * connection an agent's session makes. The server is a stand-in; nothing here reaches the network.
 */
import { toMcpEntries } from "@eta/daemon";
import { ServerManager } from "@eta/mcp";
import { describe, expect, it } from "vitest";
import { testConnection } from "../src/plugins/test-server";

const URL_ = "https://api.cursor.com/rest-mcp/google-drive/mcp";
const CURSOR = "Bearer cursor-credential-0123456789";
const GOOGLE = "google-access-token-0123456789";

interface Seen {
  names: string[];
  authorization: string | null;
  cursor: string | null;
}

/** What Cursor's server does: both layers are needed, and each missing one is answered differently. */
function server(seen: Seen[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      names: [...headers.keys()].sort(),
      authorization: headers.get("authorization"),
      cursor: headers.get("x-cursor-auth"),
    });
    if (new URL(String(input)).href !== URL_ || init?.method !== "POST")
      return new Response("not found", { status: 404 });
    if (!headers.has("x-cursor-auth"))
      return new Response(
        '{"error":"unauthorized","message":"Missing Cursor credential in x-cursor-auth"}',
        { status: 401 },
      );
    if (headers.get("authorization") !== `Bearer ${GOOGLE}`)
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://api.cursor.com/.well-known/oauth-protected-resource/rest-mcp/google-drive/mcp"',
        },
      });
    const message = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "drive", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "search",
                  description: "search",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {};
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

/** The stored sign-in a login left behind: only what the connection reads. */
const provider = () =>
  ({
    redirectUrl: "https://eta.test/mcp/oauth/callback",
    clientMetadata: { redirect_uris: ["https://eta.test/mcp/oauth/callback"] },
    clientInformation: async () => ({ client_id: "client" }),
    tokens: async () => ({ access_token: GOOGLE, token_type: "Bearer" }),
    saveTokens: async () => undefined,
    redirectToAuthorization: async () => undefined,
    saveCodeVerifier: async () => undefined,
    codeVerifier: async () => "verifier",
  }) as never;

/** The entry eta's own loop gets for this server once the user saved a Cursor credential on it. */
const entry = () =>
  Object.values(
    toMcpEntries([
      {
        type: "streamable-http",
        name: "google-drive",
        url: URL_,
        headers: { "x-cursor-auth": CURSOR },
        userHeaders: true,
      } as never,
    ]),
  )[0]!;

describe("a Cursor server with a Cursor credential and a stored OAuth sign-in", () => {
  it("is declared OAuth, so the stored sign-in is used at all", () => {
    expect((entry() as { auth?: unknown }).auth).toBe("oauth");
  });

  it("the connection test sends the sign-in and the Cursor credential together, and passes", async () => {
    const seen: Seen[] = [];
    const result = await testConnection(
      {
        ...entry(),
        name: "google-drive",
        source: "plugin-test",
        hash: "plugin-test",
      } as never,
      [],
      5000,
      () => provider(),
      server(seen),
    );
    expect(result).toMatchObject({ status: "ok", toolCount: 1 });
    const posts = seen.filter((one) => one.authorization !== null);
    expect(posts.length).toBeGreaterThan(0);
    for (const one of posts) {
      expect(one.names).toContain("authorization");
      expect(one.names).toContain("x-cursor-auth");
      expect(one.cursor).toBe(CURSOR);
    }
    expect(JSON.stringify(result)).not.toContain(GOOGLE);
  }, 30_000);

  it("a session's own connection sends both too, and lists the tools", async () => {
    const seen: Seen[] = [];
    const manager = new ServerManager({
      checkIntervalMs: 0,
      idleTimeoutMs: 0,
      fetch: server(seen) as never,
      authProviderFor: () => provider(),
    });
    try {
      const connection = await manager.connect(
        "agent-1",
        {
          ...entry(),
          name: "google-drive",
          source: "plugin:p",
          hash: "h",
        } as never,
        { force: true, signal: AbortSignal.timeout(5000) },
      );
      expect(connection.status).toBe("connected");
      expect(connection.tools.map((tool) => tool.name)).toEqual(["search"]);
      const posts = seen.filter((one) => one.authorization !== null);
      expect(posts.length).toBeGreaterThan(0);
      for (const one of posts) {
        expect(one.names).toContain("x-cursor-auth");
        expect(one.cursor).toBe(CURSOR);
      }
    } finally {
      await manager.closeAll();
    }
  }, 30_000);
});
