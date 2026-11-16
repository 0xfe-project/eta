/**
 * MCP OAuth for a session on a daemon's machine, against the fake authorization server: the
 * credentials are the primary's, and the daemon reads and writes them over the link.
 *
 * - Before anyone signs in, the session's call says the server needs a login.
 * - Signing in on the primary is enough: the same session, not reopened, calls the server next.
 * - A token the daemon refreshes is saved on the primary, where the next session finds it.
 * - The daemon keeps none of it on disk, and asks for nothing but the three relayed kinds.
 */
import type { McpServerView } from "@eta/client-contracts";
import type { McpTuning } from "../src/product";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpServerKey, parseCredentialCall } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { CredentialRows } from "../src/mcp/credentials";
import { loadSecretKey } from "../src/secret";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";

type FetchLike = NonNullable<McpTuning["fetch"]>;

const ORIGIN = "https://eta.test";
const PLUGIN = "remote-plugin";
const SERVER = "remote-plugin-remote";
const KEY = mcpServerKey(MCP_URL);

/**
 * The fake's MCP endpoint: one tool, `whoami`, answering with the token it was called with. A
 * token the test has expired gets the fake's 401, which sends a client to refresh.
 */
function endpoint(auth: ReturnType<typeof createFakeAuthServer>) {
  const expired = new Set<string>();
  const fetch: FetchLike = async (input, init) => {
    const bearer = new Headers(init?.headers).get("authorization");
    const token = bearer?.startsWith("Bearer access-")
      ? bearer.slice("Bearer ".length)
      : undefined;
    if (String(input) !== MCP_URL || token === undefined || expired.has(token))
      return await auth.fetch(input, init);
    if ((init?.method ?? "GET") !== "POST")
      return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body)) as {
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
            serverInfo: { name: "remote", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "whoami",
                  description: "Say which token called.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : message.method === "tools/call"
            ? {
                content: [{ type: "text", text: token }],
                structuredContent: { token },
              }
            : {};
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, expire: (token: string) => expired.add(token) };
}

/**
 * Every turn runs one script: call the server, and say which realm it ran in. The realm's global
 * lives as long as the session does, so the same probe on two turns is the same open session.
 */
const SCRIPT = `globalThis.__probe ??= Math.random().toString(36).slice(2);
let out;
try {
  const { whoami } = await import("mcp:${SERVER}");
  out = await whoami({});
} catch (error) {
  out = { error: String(error?.message ?? error) };
}
export default { probe: globalThis.__probe, out };`;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function setUp() {
  const told: string[] = [];
  const { models } = scriptedModels((request) => {
    if (request.lastRole === "toolResult") {
      told.push(request.last);
      return say("done");
    }
    return call("esmrun", { script: SCRIPT });
  });
  const auth = createFakeAuthServer();
  const server = endpoint(auth);
  const dataDir = await tempDir();
  const root = join(dataDir, "plugins", PLUGIN);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: PLUGIN,
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { remote: { type: "streamable-http", url: MCP_URL } },
    }),
  );
  const tuning: McpTuning = {
    fetch: server.fetch,
    manager: { resolvers: false, checkIntervalMs: 0 },
  };
  const r = await remoteWorld(
    { dataDir, models, mcp: tuning },
    { node: { mcpFetch: server.fetch, mcp: tuning.manager! } },
  );
  r.client.subscribe("plugins");
  r.client.subscribe("mcp");
  await until(() =>
    (r.client.section<{ name: string }[]>("plugins", "list") ?? []).some(
      (plugin) => plugin.name === PLUGIN,
    ),
  );
  const agent = await r.agent("Designer");
  await r.client.call("agents", "update", {
    agentId: agent.id,
    plugins: [PLUGIN],
  });
  const group = await r.group(r.remoteProject.id, [agent.id]);
  await r.watch(group.id);
  const store = new CredentialRows(r.host.db, loadSecretKey(dataDir));
  /** One turn on the daemon: what the script returned. */
  const turn = async (
    conversation = group.id,
  ): Promise<{ probe: string; out: { token?: string; error?: string } }> => {
    const sent = await r.send(conversation, "call it");
    const done = await r.settled(conversation, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    const text = told.at(-1)!;
    // The result, then a blank line and the effects and the saved script.
    return JSON.parse(text.split("\n\n")[0]!) as never;
  };
  const login = async (): Promise<void> => {
    await until(() =>
      (r.client.section<McpServerView[]>("mcp", "list") ?? []).some(
        (view) => view.agentId === agent.id && view.server === SERVER,
      ),
    );
    const { authorizationUrl } = (await r.client.call("mcp", "login", {
      agentId: agent.id,
      server: SERVER,
      redirectOrigin: ORIGIN,
    })) as { authorizationUrl: string };
    const redirect = new URL(auth.approve(authorizationUrl));
    const response = await fetch(
      `http://127.0.0.1:${r.host.port}/mcp/oauth/callback${redirect.search}`,
    );
    expect(response.status).toBe(200);
  };
  return { r, auth, server, agent, group, store, turn, login };
}

describe("an OAuth MCP server for a session on a daemon", () => {
  it("needs a login, then works in the same session once the primary signs in", async () => {
    const s = await setUp();
    const before = await s.turn();
    expect(before.out.error).toMatch(/sign-in is required/);
    const session = sessionOf(s.r, s.group.id);

    await s.login();
    expect(s.store.has(KEY, "tokens")).toBe(true);

    const after = await s.turn();
    expect(after.out.token).toMatch(/^access-/);
    // The same session, still open: nothing was reopened for the login to reach it.
    expect(sessionOf(s.r, s.group.id)).toBe(session);
    expect(after.probe).toBe(before.probe);

    // The daemon kept no credential: nothing it wrote holds the refresh token or the client.
    // (The access token is in its journal only because this tool answers with it.)
    const stored = await s.store.get(KEY, "tokens");
    const client = await s.store.get(KEY, "clientInformation");
    expect(stored?.refresh_token).toMatch(/^refresh-/);
    for (const path of filesUnder(s.r.daemon.dataDir)) {
      const text = readFileSync(path).toString("latin1");
      expect(text).not.toContain(stored!.refresh_token!);
      expect(text).not.toContain(client!.client_id);
    }
    // What crossed the link for credentials named the URL's hash and a relayed kind, nothing else.
    const relayed = s.r.traffic.out.filter((frame) =>
      frame.includes('"mcp.credential"'),
    );
    expect(relayed.length).toBeGreaterThan(0);
    for (const frame of relayed) {
      expect(frame).toContain(KEY);
      expect(frame).not.toContain("codeVerifier");
    }
  }, 30_000);

  it("saves a token the daemon refreshes on the primary, for the next session anywhere", async () => {
    const s = await setUp();
    await s.login();
    const first = (await s.turn()).out.token!;
    expect(first).toMatch(/^access-/);
    const rotated = s.auth.currentRefreshToken();

    // The access token stops working: the daemon's client refreshes it.
    s.server.expire(first);
    const second = (await s.turn()).out.token!;
    expect(second).toMatch(/^access-/);
    expect(second).not.toBe(first);

    // The refresh went to the primary's rows: the new pair, the old refresh token gone with it.
    const stored = await s.store.get(KEY, "tokens");
    expect(stored?.access_token).toBe(second);
    expect(stored?.refresh_token).toBe(s.auth.currentRefreshToken());
    expect(stored?.refresh_token).not.toBe(rotated);

    // A session on the primary reads it.
    const cwd = await tempDir("eta-mcp-project-");
    const { session } = await s.r.host.server.sessions.create({
      cwd,
      agentId: s.agent.id,
    });
    const here = await session.esm!.agent.run(`
      import { whoami } from "mcp:${SERVER}";
      export default await whoami({});
    `);
    expect(here.value).toEqual({ token: second });

    // And a new session on the daemon, in another conversation, does too.
    const other = await s.r.group(s.r.remoteProject.id, [s.agent.id]);
    await s.r.watch(other.id);
    expect((await s.turn(other.id)).out.token).toBe(second);
  }, 30_000);
});

describe("what a daemon may ask of the primary's credentials", () => {
  it("is a relayed kind under a URL's hash, and nothing else", () => {
    expect(
      parseCredentialCall({ op: "get", serverKey: KEY, kind: "tokens" }),
    ).toEqual({ op: "get", serverKey: KEY, kind: "tokens" });
    expect(
      parseCredentialCall({
        op: "set",
        serverKey: KEY,
        kind: "discoveryState",
        value: { authorizationServerUrl: "https://auth.test" },
      }).op,
    ).toBe("set");
    for (const bad of [
      { op: "get", serverKey: KEY, kind: "codeVerifier" },
      { op: "get", serverKey: MCP_URL, kind: "tokens" },
      { op: "get", serverKey: KEY.toUpperCase(), kind: "tokens" },
      { op: "list", serverKey: KEY, kind: "tokens" },
      { op: "set", serverKey: KEY, kind: "tokens", value: "x" },
      { op: "set", serverKey: KEY, kind: "tokens" },
      null,
      [],
    ])
      expect(() => parseCredentialCall(bad)).toThrow();
  });
});
