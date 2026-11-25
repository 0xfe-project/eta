/**
 * A remote plugin server that signs in with OAuth, as an external runtime gets it: the sign-in
 * token the user stored is in the server's headers when the session opens.
 */
import type { SessionMeta } from "@eta/server";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpServerKey } from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { CredentialRows } from "../src/mcp/credentials";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const URL_OF_REMOTE = "https://example.com/mcp";
const ACCESS = "access-token-0123456789";
const FRESH = "fresh-token-9876543210";
const ISSUER = "https://auth.test";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup(
  options: { headers?: Record<string, string>; auth?: false | "oauth" } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-session-token-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: PLUGIN,
      name: "demo",
      ...(options.auth === undefined
        ? {}
        : {
            extensions: {
              "tech.0xfe.eta": { mcp: { remote: { auth: options.auth } } },
            },
          }),
    }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: URL_OF_REMOTE,
          headers: options.headers ?? { "X-Api-Key": "from-file" },
        },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const key = Buffer.alloc(32, 1);
  const logs: string[] = [];
  const refreshes: string[] = [];
  /** The authorization server: refreshes with the stored refresh token, or refuses it. */
  const answer = { refuse: false };
  const fetchFn = async (input: unknown, init?: RequestInit) => {
    if (String(input) !== `${ISSUER}/token`)
      return new Response("not found", { status: 404 });
    refreshes.push(String(init?.body));
    return answer.refuse
      ? Response.json({ error: "invalid_grant" }, { status: 400 })
      : Response.json({
          access_token: FRESH,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
        });
  };
  const agent = { runtime: "codex" };
  const plugins = new Plugins({
    db,
    dataDir,
    key,
    agents: { get: () => agent } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: (message) => logs.push(message),
    fetchFn: fetchFn as never,
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const meta = { agentId: "ada", runtime: "codex" } as SessionMeta;
  const store = new CredentialRows(db, key);
  const serverKey = mcpServerKey(URL_OF_REMOTE);
  /** A stored sign-in; `expires_in` of 30 seconds is already inside the refresh margin. */
  const signIn = async (expiresIn = 3600) => {
    await store.set(serverKey, "tokens", {
      access_token: ACCESS,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: "refresh-1",
    });
    await store.set(serverKey, "clientInformation", { client_id: "eta" });
    await store.set(serverKey, "discoveryState", {
      authorizationServerUrl: ISSUER,
      authorizationServerMetadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    } as never);
  };
  const headers = async () => {
    const extras = await plugins.runtimeExtrasFor(meta);
    const [server] = extras.mcpServers ?? [];
    return (server as { headers?: Record<string, string> } | undefined)
      ?.headers;
  };
  const link = {
    machineId: "m1",
    machine: async (op: string) => (op === "pluginHave" ? { missing: [] } : {}),
  } as never;
  return {
    plugins,
    meta,
    store,
    serverKey,
    signIn,
    headers,
    logs,
    refreshes,
    answer,
    agent,
    link,
  };
}

describe("the sign-in token of an OAuth server, for an external runtime", () => {
  it("is the server's Authorization header, next to the plugin's own", async () => {
    const { plugins, meta, signIn } = await setup();
    await signIn();
    const extras = await plugins.runtimeExtrasFor(meta);
    expect(extras.mcpServers).toEqual([
      {
        name: "demo-remote",
        type: "http",
        url: URL_OF_REMOTE,
        headers: {
          "X-Api-Key": "from-file",
          Authorization: `Bearer ${ACCESS}`,
        },
      },
    ]);
  });

  it.each([
    ["raw", ACCESS],
    ["bearer", `Bearer ${ACCESS}`],
  ] as const)(
    "is also the header the server names, in the %s format",
    async (format, value) => {
      const { plugins, signIn, headers } = await setup();
      await signIn();
      plugins.setTokenHeader("demo", "remote", { name: "x-token", format });
      expect(await headers()).toEqual({
        "X-Api-Key": "from-file",
        Authorization: `Bearer ${ACCESS}`,
        "x-token": value,
      });
    },
  );

  it("is refreshed first when it has run out, and the new token is what is sent", async () => {
    const { signIn, headers, refreshes, store, serverKey } = await setup();
    await signIn(30);
    expect((await headers())?.Authorization).toBe(`Bearer ${FRESH}`);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toContain("refresh_token=refresh-1");
    // What was refreshed is what is stored for the next session.
    expect((await store.get(serverKey, "tokens"))?.access_token).toBe(FRESH);
  });

  it("is not refreshed while it is good", async () => {
    const { signIn, headers, refreshes } = await setup();
    await signIn(3600);
    await headers();
    expect(refreshes).toEqual([]);
  });

  it("is left out, and the server still sent, when nothing is signed in; the log says why", async () => {
    const { plugins, meta, logs } = await setup();
    const extras = await plugins.runtimeExtrasFor(meta);
    expect(extras.mcpServers).toEqual([
      {
        name: "demo-remote",
        type: "http",
        url: URL_OF_REMOTE,
        headers: { "X-Api-Key": "from-file" },
      },
    ]);
    expect(logs.join("\n")).toContain(
      "plugin demo: server remote has no sign-in",
    );
  });

  it("is left out when the refresh is refused, and no log carries a token", async () => {
    const { plugins, meta, signIn, answer, logs } = await setup();
    await signIn(30);
    answer.refuse = true;
    const extras = await plugins.runtimeExtrasFor(meta);
    expect(extras.mcpServers).toEqual([
      {
        name: "demo-remote",
        type: "http",
        url: URL_OF_REMOTE,
        headers: { "X-Api-Key": "from-file" },
      },
    ]);
    const said = logs.join("\n");
    expect(said).toContain("could not be refreshed");
    expect(said).not.toContain(ACCESS);
    expect(said).not.toContain(FRESH);
    expect(said).not.toContain("refresh-1");
  });

  it("leaves a header the user or the plugin already sends under the same name", async () => {
    const { plugins, signIn, headers } = await setup();
    await signIn();
    plugins.setHeaders("demo", "remote", [
      { name: "authorization", value: "Bearer from-user", secret: true },
    ]);
    expect(await headers()).toEqual({
      "X-Api-Key": "from-file",
      authorization: "Bearer from-user",
    });
  });

  it("changes nothing for a server that is not OAuth: its own headers only", async () => {
    const { signIn, headers } = await setup({
      headers: { "X-Api-Key": "from-file" },
      auth: false,
    });
    await signIn();
    expect(await headers()).toEqual({ "X-Api-Key": "from-file" });
  });

  it("is in what a session must not pass on", async () => {
    const { plugins, signIn } = await setup();
    await signIn();
    expect(plugins.redactionsFor("ada").map((one) => one.value)).not.toContain(
      ACCESS,
    );
    await plugins.runtimeExtrasFor({
      agentId: "ada",
      runtime: "codex",
    } as SessionMeta);
    expect(plugins.redactionsFor("ada")).toContainEqual({
      value: ACCESS,
      label: "[secret demo.remote sign-in]",
    });
  });

  it("goes to a daemon with the servers of an external runtime, and not with eta's own", async () => {
    const { plugins, signIn, agent, link } = await setup();
    await signIn();
    const authorization = async () =>
      (await plugins.openOn(link, "ada"))[0]?.servers.remote?.headers
        ?.Authorization;
    expect(await authorization()).toBe(`Bearer ${ACCESS}`);
    agent.runtime = "eta";
    expect(await authorization()).toBeUndefined();
  });
});
