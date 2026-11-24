/**
 * The Cursor credential is saved once for the host. Every server on cursor.com gets it next to its own
 * sign-in, the user's own header on a server comes first, and no other server ever sees it.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_AUTH_HEADER } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { pluginsPlugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/service";
import { testConnection } from "../src/plugins/test-server";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const HOST = "Bearer host-credential-0123456789";
const OWN = "Bearer own-credential-0123456789";
const GOOGLE = "google-access-token-0123456789";
const DOCS = "https://api.cursor.com/rest-mcp/slides/mcp";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-cursor-credential-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN, name: "demo" }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: {
        drive: {
          type: "streamable-http",
          url: "https://api.cursor.com/rest-mcp/google-drive/mcp",
        },
        docs: { type: "streamable-http", url: DOCS },
        other: { type: "streamable-http", url: "https://example.com/mcp" },
        lookalike: {
          type: "streamable-http",
          url: "https://cursor.com.evil.test/mcp",
        },
        local: { type: "stdio", command: "node" },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 1),
    agents: { get: () => ({ runtime: "eta" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const servers = () =>
    plugins.mcpSourcesFor("ada")[0]?.servers as Record<
      string,
      { headers?: Record<string, string>; auth?: unknown }
    >;
  return { plugins, servers };
}

/** What Cursor's server does: it wants both layers, the Cursor credential and the service's sign-in. */
function server(seen: { names: string[] }[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ names: [...headers.keys()].sort() });
    if (String(input) !== DOCS || init?.method !== "POST")
      return new Response("not found", { status: 404 });
    if (headers.get("x-cursor-auth") !== HOST)
      return new Response('{"error":"unauthorized"}', { status: 401 });
    if (headers.get("authorization") !== `Bearer ${GOOGLE}`)
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://api.cursor.com/.well-known/oauth-protected-resource/rest-mcp/slides/mcp"',
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
            serverInfo: { name: "slides", version: "1.0.0" },
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

describe("the Cursor credential, saved once for the host", () => {
  it("a Cursor sign-in made on one server is sent to another Cursor server, next to its own OAuth sign-in", async () => {
    const { plugins, servers } = await setup();
    plugins.setCursorCredential(HOST);
    expect(servers()["demo-docs"]?.headers).toEqual({
      [CURSOR_AUTH_HEADER]: HOST,
    });
    // The user's header is still a user header: the service behind it signs in with OAuth.
    expect(servers()["demo-docs"]?.auth).toBe("oauth");
    const plan = plugins.testPlan("demo", "docs");
    if (!("entry" in plan)) throw new Error("no plan");
    const seen: { names: string[] }[] = [];
    const result = await testConnection(
      {
        ...plan.entry,
        name: "demo-docs",
        source: "plugin-test",
        hash: "plugin-test",
      } as never,
      plan.secrets,
      5000,
      () => provider(),
      server(seen),
    );
    expect(result).toMatchObject({ status: "ok", toolCount: 1 });
    for (const one of seen.filter((s) => s.names.includes("authorization")))
      expect(one.names).toContain(CURSOR_AUTH_HEADER);
    expect(JSON.stringify(result)).not.toContain(HOST);
  }, 30_000);

  it("the Cursor sign-in on the wire saves it for the host, not for the one server", async () => {
    const { plugins, servers } = await setup();
    const handlers = new Map<string, (call: unknown) => unknown>();
    const wire = new Proxy(
      {
        handle: (target: string, action: string, run: never) => {
          handlers.set(`${target}.${action}`, run);
          return () => {};
        },
      } as Record<string, unknown>,
      { get: (self, key: string) => self[key] ?? (() => () => {}) },
    );
    pluginsPlugin(
      {
        plugins,
        agents: {} as never,
        market: {} as never,
        cursorLogin: {
          start: (done: (token: string) => void) => {
            done("host-token-0123456789");
            return { id: "1", url: "https://cursor.com/login" };
          },
        } as never,
      },
      () => {},
    ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
    handlers.get("plugins.cursorLoginStart")!({
      target: "plugins",
      action: "cursorLoginStart",
      args: { name: "demo", server: "drive" },
    });
    expect(servers()["demo-docs"]?.headers?.[CURSOR_AUTH_HEADER]).toBe(
      "Bearer host-token-0123456789",
    );
    expect(
      plugins.rows
        .headers("demo")
        .some((header) => header.name === CURSOR_AUTH_HEADER),
    ).toBe(false);
  });

  it("is never sent to a server that is not Cursor's, a lookalike host included", async () => {
    const { plugins, servers } = await setup();
    plugins.setCursorCredential(HOST);
    for (const name of ["demo-other", "demo-lookalike"])
      expect(servers()[name]?.headers?.[CURSOR_AUTH_HEADER]).toBeUndefined();
  });

  it("a header the user saved on the server comes first, and the others still get the host's", async () => {
    const { plugins, servers } = await setup();
    plugins.setCursorCredential(HOST);
    plugins.setSecretHeader("demo", "drive", CURSOR_AUTH_HEADER, OWN);
    expect(servers()["demo-drive"]?.headers).toEqual({
      [CURSOR_AUTH_HEADER]: OWN,
    });
    expect(servers()["demo-docs"]?.headers).toEqual({
      [CURSOR_AUTH_HEADER]: HOST,
    });
  });

  it("a new sign-in brings a Cursor server's own saved copy up to date, and leaves other servers' headers alone", async () => {
    const { plugins, servers } = await setup();
    plugins.setSecretHeader("demo", "drive", CURSOR_AUTH_HEADER, OWN);
    plugins.setSecretHeader("demo", "other", CURSOR_AUTH_HEADER, OWN);
    plugins.setCursorCredential(HOST);
    expect(servers()["demo-drive"]?.headers).toEqual({
      [CURSOR_AUTH_HEADER]: HOST,
    });
    // A server that is not Cursor's keeps what the user typed there.
    expect(servers()["demo-other"]?.headers).toEqual({
      [CURSOR_AUTH_HEADER]: OWN,
    });
  });

  it("makes every Cursor server read as signed in, and the value is in no view and is redacted", async () => {
    const { plugins } = await setup();
    const states = () =>
      plugins
        .view()
        .find((entry) => entry.name === "demo")!
        .servers.map((one) => [one.name, one.cursorSignedIn]);
    expect(states()).toContainEqual(["docs", false]);
    plugins.setCursorCredential(HOST);
    expect(states()).toContainEqual(["docs", true]);
    expect(states()).toContainEqual(["drive", true]);
    expect(states().find(([name]) => name === "other")?.[1]).toBeUndefined();
    expect(JSON.stringify(plugins.view())).not.toContain(HOST);
    expect(
      plugins.redactionsFor(undefined).map((redaction) => redaction.value),
    ).toContain(HOST);
  });

  it("changes the stamp of what a session was opened with, so its sessions reopen", async () => {
    const { plugins } = await setup();
    const before = plugins.stampOf("ada");
    await new Promise((resolve) => setTimeout(resolve, 5));
    plugins.setCursorCredential(HOST);
    expect(plugins.stampOf("ada")).not.toBe(before);
  });
});
