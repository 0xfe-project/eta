/**
 * Composio toolkits as virtual plugins: one tool_router session per connected toolkit, made when the
 * toolkit is connected, checked against what Composio echoes back, and given to the agents that
 * enabled it. Against a local fake of backend.composio.dev that echoes the config it was given;
 * nothing reaches the network and no real key is used.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedCredentialTable } from "../src/credentials/table";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Composio } from "../src/plugins/composio";
import { CatalogCache } from "../src/plugins/market-cache";
import { Plugins } from "../src/plugins/service";
import { SettingStore } from "../src/settings/store";

/** What a Composio gets with adding: not there yet, so the tests name it here. */
interface Adding {
  add: (slug: string) => Promise<{ status: string }>;
  remove: (slug: string) => { removed: boolean };
  added: () => string[];
}

const KEY = "ck_test_SECRET_0123456789";
const OTHER_KEY = "ck_test_OTHER_9876543210";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Seen {
  method: string;
  path: string;
  key: string | null;
  body: string;
}
let seen: Seen[];
let accounts: string[];
/** What the fake lists at GET /api/v3/toolkits. */
let toolkits: unknown[];
let sessions: Map<string, { slug: string; config: unknown }>;
let counter: number;
/** What the fake puts in "config" of an answer; the default echoes the request. */
let echo: (body: Record<string, any>) => unknown;
let create: (body: Record<string, any>) => Response | undefined;
/** What the fake lists at GET /api/v3/auth_configs; none listed means the route is not there. */
let configs: Record<string, any>[] | undefined;
/** How the fake answers a PATCH of an auth config: undefined for success. */
let patchAnswer: () => Response | undefined;
let server: ReturnType<typeof Bun.serve>;
const base = () => `http://127.0.0.1:${server.port}`;

const answer = (id: string, config: unknown, status = 200) =>
  json(
    {
      session_id: id,
      mcp: { type: "http", url: `${base()}/tool_router/${id}/mcp` },
      config,
      warnings: [],
    },
    status,
  );

beforeEach(() => {
  seen = [];
  accounts = [];
  toolkits = [];
  sessions = new Map();
  counter = 0;
  echo = (body) => ({
    toolkits: { enabled: body.toolkits?.enable },
    manage_connections: {
      enable_connection_removal:
        body.manage_connections?.enable_connection_removal,
    },
    workbench: { enable: body.workbench?.enable },
  });
  create = () => undefined;
  configs = undefined;
  patchAnswer = () => undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        key: request.headers.get("x-api-key"),
        body,
      });
      if (request.method === "GET" && url.pathname === "/api/v3/toolkits")
        return json({ items: toolkits, next_cursor: null });
      if (
        request.method === "GET" &&
        url.pathname === "/api/v3/auth_configs" &&
        configs !== undefined
      )
        return json({ items: configs, next_cursor: null });
      if (
        request.method === "PATCH" &&
        url.pathname.startsWith("/api/v3/auth_configs/")
      ) {
        const refused = patchAnswer();
        if (refused !== undefined) return refused;
        return json({ success: true });
      }
      if (url.pathname === "/api/v3/connected_accounts")
        return json({
          items: accounts.map((slug, index) => ({
            id: `ca_${index}`,
            status: "ACTIVE",
            user_id: url.searchParams.get("user_ids"),
            toolkit: { slug },
          })),
          next_cursor: null,
        });
      if (
        request.method === "POST" &&
        url.pathname === "/api/v3.1/tool_router/session"
      ) {
        const parsed = JSON.parse(body) as Record<string, any>;
        const refused = create(parsed);
        if (refused !== undefined) return refused;
        const id = `sess-${++counter}`;
        const config = echo(parsed);
        sessions.set(id, { slug: parsed.toolkits?.enable?.[0], config });
        return answer(id, config, 201);
      }
      const asked = /^\/api\/v3\.1\/tool_router\/session\/([\w-]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && asked !== null) {
        const known = sessions.get(asked[1]!);
        return known === undefined
          ? json({ error: "gone" }, 404)
          : answer(asked[1]!, known.config);
      }
      return json({}, 404);
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  vi.restoreAllMocks();
});

function open(options: { now?: () => number } = {}) {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const settings = new SettingStore(db);
  const cache = new CatalogCache(db, { maxRowBytes: 1024 * 1024 });
  const start = () =>
    new Composio({
      db,
      key: Buffer.alloc(32, 7),
      settings,
      cache,
      baseUrl: base(),
      ...options,
    }) as Composio & Adding;
  const composio = start();
  composio.setKey(KEY);
  const stored = (slug: string) =>
    new EncryptedCredentialTable(db, Buffer.alloc(32, 7)).read(
      "market",
      `composio-session:${slug}`,
      "secret",
    );
  return { db, settings, composio, start, stored };
}

const posts = () =>
  seen.filter(
    (one) =>
      one.method === "POST" && one.path === "/api/v3.1/tool_router/session",
  );
const patches = () => seen.filter((one) => one.method === "PATCH");
const gets = () =>
  seen.filter(
    (one) =>
      one.method === "GET" &&
      one.path.startsWith("/api/v3.1/tool_router/session/"),
  );

describe("a session for a connected toolkit", () => {
  it("is made with exactly one toolkit, connection removal off and the workbench off, under this host's user and key", async () => {
    const { composio, settings } = open();
    await composio.sync(["gmail"]);
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]!.body) as Record<string, any>;
    expect(sent).toMatchObject({
      toolkits: { enable: ["gmail"] },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
    });
    expect(sent.user_id).toBe(settings.get("plugins.composioUserId"));
    expect(posts()[0]!.key).toBe(KEY);
    expect(composio.virtuals()).toMatchObject([
      { name: "@composio/gmail", slug: "gmail", state: "ready" },
    ]);
    expect(composio.has("@composio/gmail")).toBe(true);
  });

  it("serves its address with the key as a header, and only for a ready toolkit", async () => {
    const { composio } = open();
    await composio.sync(["gmail"]);
    expect(composio.mcpSource("@composio/gmail")).toEqual({
      name: "composio:gmail",
      servers: {
        "composio-gmail": {
          type: "http",
          url: `${base()}/tool_router/sess-1/mcp`,
          headers: { "x-api-key": KEY },
        },
      },
    });
    expect(composio.mcpSource("@composio/other")).toBeUndefined();
    expect(JSON.stringify(composio.virtuals())).not.toContain(KEY);
  });

  it("is not registered when Composio echoes another toolkit list, and nothing is kept", async () => {
    const { composio, stored } = open();
    echo = (body) => ({
      toolkits: { enabled: [...body.toolkits.enable, "github"] },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
    });
    await composio.sync(["gmail"]);
    expect(composio.virtuals()).toMatchObject([
      { slug: "gmail", state: "error" },
    ]);
    expect(composio.has("@composio/gmail")).toBe(false);
    expect(composio.mcpSource("@composio/gmail")).toBeUndefined();
    expect(stored("gmail")).toBeUndefined();
  });

  it.each([
    [
      "connection removal left on",
      { enable_connection_removal: true },
      "manage_connections",
    ],
    ["the workbench left on", { enable: true }, "workbench"],
  ])("is not registered with %s", async (_label, value, field) => {
    const { composio, stored } = open();
    echo = (body) => ({
      toolkits: { enabled: body.toolkits.enable },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
      [field]: value,
    });
    await composio.sync(["gmail"]);
    expect(composio.has("@composio/gmail")).toBe(false);
    expect(stored("gmail")).toBeUndefined();
  });

  it("is not registered when the answer has no config to check", async () => {
    const { composio, stored } = open();
    echo = () => undefined;
    await composio.sync(["gmail"]);
    expect(composio.virtuals()).toMatchObject([{ state: "error" }]);
    expect(stored("gmail")).toBeUndefined();
  });

  it("is not registered when the address is not on Composio's side, and the key goes nowhere else", async () => {
    const { composio } = open();
    create = () =>
      json(
        {
          session_id: "sess-x",
          mcp: { type: "http", url: "http://evil.example/mcp" },
          config: echo({
            toolkits: { enable: ["gmail"] },
            manage_connections: { enable_connection_removal: false },
            workbench: { enable: false },
          }),
        },
        201,
      );
    await composio.sync(["gmail"]);
    expect(composio.has("@composio/gmail")).toBe(false);
  });

  it("says error when Composio refuses to make it, without its text or the key, and does not ask again at once", async () => {
    let at = 1_000;
    const { composio } = open({ now: () => at });
    create = () => json({ message: `boom ${KEY}` }, 500);
    await composio.sync(["gmail"]);
    expect(composio.virtuals()).toMatchObject([
      { slug: "gmail", state: "error" },
    ]);
    expect(JSON.stringify(composio.virtuals())).not.toContain("boom");
    await composio.sync(["gmail"]);
    await composio.sync(["gmail"]);
    expect(posts()).toHaveLength(1);
    // After the pause one more try is made, and it works.
    create = () => undefined;
    at += 6 * 60_000;
    await composio.sync(["gmail"]);
    expect(posts()).toHaveLength(2);
    expect(composio.has("@composio/gmail")).toBe(true);
  });

  it("is not tried again for the rest of the run when Composio echoed something else", async () => {
    let at = 1_000;
    const { composio } = open({ now: () => at });
    echo = () => ({ toolkits: { enabled: ["x"] } });
    await composio.sync(["gmail"]);
    at += 60 * 60_000;
    await composio.sync(["gmail"]);
    expect(posts()).toHaveLength(1);
  });

  it("is made once when asked twice at the same time", async () => {
    const { composio } = open();
    await Promise.all([composio.sync(["gmail"]), composio.sync(["gmail"])]);
    expect(posts()).toHaveLength(1);
  });

  it("is made for no more than three toolkits at a time", async () => {
    const { composio } = open();
    let running = 0;
    let most = 0;
    create = () => undefined;
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const post =
        init?.method === "POST" && String(input).endsWith("/session");
      if (post) most = Math.max(most, ++running);
      try {
        if (post) await new Promise((resolve) => setTimeout(resolve, 20));
        return await original(input, init);
      } finally {
        if (post) running--;
      }
    });
    await composio.sync(["a", "b", "c", "d", "e", "f"]);
    expect(posts()).toHaveLength(6);
    expect(most).toBeLessThanOrEqual(3);
  });

  it("makes none without a key", async () => {
    const { composio } = open();
    composio.clearKey();
    await composio.sync(["gmail"]);
    expect(posts()).toHaveLength(0);
    expect(composio.virtuals()).toEqual([]);
  });

  it("is kept as its id only, and found again with one read after a restart", async () => {
    const { composio, start, stored } = open();
    await composio.sync(["gmail"]);
    expect(stored("gmail")).toBe("sess-1");
    const again = start();
    await again.sync(["gmail"]);
    expect(posts()).toHaveLength(1);
    expect(gets()).toHaveLength(1);
    expect(again.has("@composio/gmail")).toBe(true);
    expect(
      again.mcpSource("@composio/gmail")?.servers["composio-gmail"],
    ).toMatchObject({
      url: `${base()}/tool_router/sess-1/mcp`,
    });
  });

  it("is made again once when Composio no longer knows the kept id, and not in a loop when that fails", async () => {
    const { composio, start, stored } = open();
    await composio.sync(["gmail"]);
    sessions.clear();
    const again = start();
    await again.sync(["gmail"]);
    expect(gets()).toHaveLength(1);
    expect(posts()).toHaveLength(2);
    expect(stored("gmail")).toBe("sess-2");
    sessions.clear();
    create = () => json({}, 500);
    const third = start();
    await third.sync(["gmail"]);
    expect(posts()).toHaveLength(3);
    expect(third.has("@composio/gmail")).toBe(false);
    expect(stored("gmail")).toBeUndefined();
  });

  it("is dropped, and its kept id erased, when the toolkit is no longer connected", async () => {
    const { composio, stored } = open();
    await composio.sync(["gmail", "notion"]);
    await composio.sync(["notion"]);
    expect(stored("gmail")).toBeUndefined();
    expect(stored("notion")).toBe("sess-2");
    expect(composio.virtuals().map((one) => one.slug)).toEqual(["notion"]);
  });

  it("is made when the connected accounts are read, without the reading waiting for it", async () => {
    const { composio } = open();
    accounts = ["gmail"];
    const read = await composio.follow();
    expect(read).toEqual({ status: "ready", slugs: ["gmail"] });
    await vi.waitFor(() => expect(composio.has("@composio/gmail")).toBe(true));
  });

  it("is kept when a read of the connected accounts fails: that says nothing of what is connected", async () => {
    const { composio } = open();
    await composio.sync(["gmail"]);
    accounts = [];
    server.stop(true);
    server = Bun.serve({ port: 0, fetch: () => json({}, 500) });
    // The fake moved to another port: the base no longer answers, as if Composio were silent.
    const read = await composio.follow();
    expect(read.status).not.toBe("ready");
    expect(composio.has("@composio/gmail")).toBe(true);
  });

  it("is dropped, and every kept id erased, when the key is replaced or cleared", async () => {
    const { composio, stored } = open();
    await composio.sync(["gmail", "notion"]);
    composio.setKey(OTHER_KEY);
    expect(composio.virtuals()).toEqual([]);
    expect(stored("gmail")).toBeUndefined();
    expect(stored("notion")).toBeUndefined();
    await composio.sync(["gmail"]);
    composio.clearKey();
    expect(composio.virtuals()).toEqual([]);
    expect(stored("gmail")).toBeUndefined();
  });

  it("is not offered while the source is switched off, and is again when it is switched on", async () => {
    const { composio } = open();
    await composio.sync(["gmail"]);
    composio.setEnabled(false);
    expect(composio.virtuals()).toEqual([]);
    expect(composio.has("@composio/gmail")).toBe(false);
    expect(composio.mcpSource("@composio/gmail")).toBeUndefined();
    composio.setEnabled(true);
    expect(composio.has("@composio/gmail")).toBe(true);
  });

  it("tells the plugins when it changes", async () => {
    const { composio } = open();
    const changed = vi.fn();
    composio.onChange(changed);
    await composio.sync(["gmail"]);
    expect(changed).toHaveBeenCalled();
  });
});

describe("a Composio toolkit as a plugin of the agents", () => {
  function setup() {
    const world = open();
    const changes: number[] = [];
    const plugins = new Plugins({
      db: world.db,
      dataDir: "unused",
      key: Buffer.alloc(32, 1),
      agents: { get: () => ({ runtime: "eta" }) } as never,
      machines: { list: () => [] } as never,
      hub: { onReady: () => {} } as never,
      changed: () => changes.push(1),
      warn: () => {},
    });
    plugins.setVirtual(world.composio);
    plugins.rows.setEnabled("ada", ["@composio/gmail"]);
    return { ...world, plugins, changes };
  }

  it("gives an agent that enabled it the server, and one that did not nothing", async () => {
    const { composio, plugins } = setup();
    await composio.sync(["gmail"]);
    expect(plugins.mcpSourcesFor("ada")).toEqual([
      composio.mcpSource("@composio/gmail"),
    ]);
    expect(plugins.mcpSourcesFor("bob")).toEqual([]);
    expect(plugins.skipped("ada")).toEqual([]);
  });

  it("can be enabled for an agent only while it is ready", async () => {
    const { composio, plugins } = setup();
    expect(plugins.canEnable("@composio/gmail")).toBe(false);
    await composio.sync(["gmail"]);
    expect(plugins.canEnable("@composio/gmail")).toBe(true);
    expect(plugins.canEnable("@composio/nothing")).toBe(false);
  });

  it("is not a plugin of the wire list, and not read from disk", async () => {
    const { composio, plugins } = setup();
    await composio.sync(["gmail"]);
    expect(plugins.view().map((one) => one.name)).toEqual([]);
    expect(plugins.active("ada")).toEqual([]);
  });

  it("is switched for every agent by the same switch as any plugin, and the agents' choices stay", async () => {
    const { composio, plugins, changes } = setup();
    await composio.sync(["gmail"]);
    const seenChanges = changes.length;
    plugins.setEnabled("@composio/gmail", false);
    expect(changes.length).toBe(seenChanges + 1);
    expect(plugins.rows.disabled().has("@composio/gmail")).toBe(true);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(plugins.skipped("ada")).toEqual([]);
    expect(plugins.rows.enabled("ada")).toEqual(["@composio/gmail"]);
    plugins.setEnabled("@composio/gmail", true);
    expect(plugins.mcpSourcesFor("ada")).toHaveLength(1);
  });

  it("is refused a switch when there is no such plugin", () => {
    const { plugins } = setup();
    expect(() => plugins.setEnabled("@composio/nothing", false)).toThrow(
      /no such plugin/,
    );
  });

  it("stays in the agent's choices, and offers nothing, when the toolkit is no longer connected", async () => {
    const { composio, plugins } = setup();
    await composio.sync(["gmail"]);
    await composio.sync([]);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(plugins.skipped("ada")).toEqual([]);
    expect(plugins.rows.enabled("ada")).toEqual(["@composio/gmail"]);
    await composio.sync(["gmail"]);
    expect(plugins.mcpSourcesFor("ada")).toHaveLength(1);
  });

  it("gives an agent on an external runtime nothing, and the key does not go to it", async () => {
    const { composio, plugins } = setup();
    await composio.sync(["gmail"]);
    const extras = await plugins.runtimeExtrasFor({
      agentId: "ada",
      runtime: "codex",
    } as never);
    expect(JSON.stringify(extras)).not.toContain(KEY);
    expect(extras.mcpServers ?? []).toEqual([]);
  });

  it("changes the stamp of its agents' sessions when the session is another one", async () => {
    const { composio, plugins } = setup();
    expect(plugins.stampOf("ada")).toBe("");
    await composio.sync(["gmail"]);
    const first = plugins.stampOf("ada");
    expect(first).toContain("@composio/gmail");
    expect(first).not.toContain(KEY);
    composio.setKey(OTHER_KEY);
    await composio.sync(["gmail"]);
    expect(plugins.stampOf("ada")).not.toBe(first);
    expect(plugins.stampOf("bob")).toBe("");
  });

  it("is in what a session must not pass on: the key", async () => {
    const { plugins } = setup();
    expect(plugins.redactionsFor(undefined)).toContainEqual({
      value: KEY,
      label: expect.stringContaining("composio"),
    });
  });
});

/* ------------------------------------------------ a toolkit that needs no sign-in */

const kit = (slug: string, schemes: string[], none = false) => ({
  slug,
  name: slug.toUpperCase(),
  auth_schemes: schemes,
  composio_managed_auth_schemes: none ? [] : schemes,
  no_auth: none,
  meta: { description: `the ${slug} toolkit` },
});
/** What the host's list says: hackernews needs no sign-in, gmail is OAuth, odd has a scheme eta does not know. */
const list = async (composio: Composio) => {
  toolkits = [
    kit("hackernews", ["NO_AUTH"], true),
    kit("gmail", ["OAUTH2"]),
    kit("odd", ["SOMETHING_NEW"]),
  ];
  await composio.read(composio.source(), "refresh");
  seen.length = 0;
};
const signIn = () =>
  seen.filter(
    (one) =>
      one.path.startsWith("/api/v3/auth_configs") ||
      one.path.startsWith("/api/v3/connected_accounts/link"),
  );

describe("adding a toolkit that needs no sign-in", () => {
  it.fails("asks Composio for no auth config and no link, and makes its one session", async () => {
    const { composio, settings } = open();
    await list(composio);
    expect(await composio.add("hackernews")).toEqual({ status: "ready" });
    expect(signIn()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]!.body) as Record<string, any>;
    // The body is fixed. Whether Composio accepts such a session for a no-auth toolkit is not verified.
    expect(sent).toMatchObject({
      toolkits: { enable: ["hackernews"] },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
    });
    expect(sent.user_id).toBe(settings.get("plugins.composioUserId"));
    expect(composio.added()).toEqual(["hackernews"]);
    expect(composio.virtuals()).toMatchObject([
      { name: "@composio/hackernews", slug: "hackernews", state: "ready" },
    ]);
    expect(composio.has("@composio/hackernews")).toBe(true);
  });

  it.fails("refuses a toolkit that signs in, one the list does not know, and a name that is no slug: no request, nothing kept", async () => {
    const { composio, settings } = open();
    await list(composio);
    for (const slug of ["gmail", "odd", "ghost", "../x"])
      await expect(composio.add(slug)).rejects.toThrow();
    expect(seen).toHaveLength(0);
    expect(composio.added()).toEqual([]);
    expect(settings.get("plugins.composioAdded")).toBeUndefined();
  });

  it.fails("needs a key: a status, no request, nothing kept", async () => {
    const { composio, settings } = open();
    await list(composio);
    composio.clearKey();
    expect(await composio.add("hackernews")).toEqual({ status: "needs_key" });
    expect(seen).toHaveLength(0);
    expect(settings.get("plugins.composioAdded")).toBeUndefined();
  });

  it.fails("is kept across a restart, and its session is found again with one read", async () => {
    const { composio, start } = open();
    await list(composio);
    await composio.add("hackernews");
    const again = start();
    expect(again.added()).toEqual(["hackernews"]);
    seen.length = 0;
    await again.follow();
    await vi.waitFor(() =>
      expect(again.has("@composio/hackernews")).toBe(true),
    );
    expect(posts()).toHaveLength(0);
    expect(gets()).toHaveLength(1);
  });

  it.fails("is not dropped when the connected accounts are read: it is made for what is added as well as what is connected", async () => {
    const { composio } = open();
    await list(composio);
    accounts = ["gmail"];
    await composio.add("hackernews");
    await composio.follow();
    await vi.waitFor(() => expect(composio.has("@composio/gmail")).toBe(true));
    expect(composio.has("@composio/hackernews")).toBe(true);
    expect(composio.virtuals().map((one) => one.slug)).toEqual([
      "gmail",
      "hackernews",
    ]);
  });

  it.fails("is removed without a request to Composio: its session and kept id go, the list loses it", async () => {
    const { composio, settings, stored } = open();
    await list(composio);
    await composio.add("hackernews");
    expect(stored("hackernews")).toBe("sess-1");
    seen.length = 0;
    expect(composio.remove("hackernews")).toEqual({ removed: true });
    expect(seen).toHaveLength(0);
    expect(composio.added()).toEqual([]);
    expect(settings.get("plugins.composioAdded")).toBeUndefined();
    expect(stored("hackernews")).toBeUndefined();
    expect(composio.virtuals()).toEqual([]);
    expect(composio.remove("hackernews")).toEqual({ removed: false });
    await composio.follow();
    expect(composio.virtuals()).toEqual([]);
  });

  it.fails("is removed from the list only for a slug that was added: a connected toolkit's session is not touched", async () => {
    const { composio } = open();
    await list(composio);
    await composio.sync(["gmail"]);
    expect(composio.remove("gmail")).toEqual({ removed: false });
    expect(composio.has("@composio/gmail")).toBe(true);
  });

  it.fails("keeps the list when the key goes, and makes the session again when a key comes back", async () => {
    const { composio, settings, stored } = open();
    await list(composio);
    await composio.add("hackernews");
    composio.clearKey();
    expect(composio.virtuals()).toEqual([]);
    expect(stored("hackernews")).toBeUndefined();
    expect(settings.get("plugins.composioAdded")).toEqual(["hackernews"]);
    expect(composio.added()).toEqual([]);
    composio.setKey(KEY);
    await composio.follow();
    await vi.waitFor(() =>
      expect(composio.has("@composio/hackernews")).toBe(true),
    );
    expect(composio.added()).toEqual(["hackernews"]);
  });

  it.fails("is not trusted when Composio echoes another toolkit list: no plugin, and the self-check is the one the connected ones have", async () => {
    const { composio } = open();
    await list(composio);
    echo = (body) => ({
      toolkits: { enabled: [...body.toolkits.enable, "github"] },
      manage_connections: { enable_connection_removal: false },
      workbench: { enable: false },
    });
    expect(await composio.add("hackernews")).toEqual({ status: "ready" });
    expect(composio.virtuals()).toMatchObject([
      { slug: "hackernews", state: "error" },
    ]);
    expect(composio.has("@composio/hackernews")).toBe(false);
  });

  it.fails("is an agent's choice like any plugin's: the choice stays when it is removed", async () => {
    const { composio, db } = open();
    await list(composio);
    const plugins = new Plugins({
      db,
      dataDir: "unused",
      key: Buffer.alloc(32, 1),
      agents: { get: () => ({ runtime: "eta" }) } as never,
      machines: { list: () => [] } as never,
      hub: { onReady: () => {} } as never,
      changed: () => {},
      warn: () => {},
    });
    plugins.setVirtual(composio);
    await composio.add("hackernews");
    expect(plugins.canEnable("@composio/hackernews")).toBe(true);
    plugins.rows.setEnabled("ada", ["@composio/hackernews"]);
    expect(plugins.mcpSourcesFor("ada")).toHaveLength(1);
    composio.remove("hackernews");
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(plugins.rows.enabled("ada")).toEqual(["@composio/hackernews"]);
  });

  it.fails("has the key in no answer and no kept list", async () => {
    const { composio, settings } = open();
    await list(composio);
    await composio.add("hackernews");
    expect(
      JSON.stringify([
        composio.virtuals(),
        composio.added(),
        settings.get("plugins.composioAdded"),
      ]),
    ).not.toContain(KEY);
  });
});

describe("the tool router switch of a toolkit's managed auth config", () => {
  const managed = (id: string, flag?: boolean, extra: object = {}) => ({
    id,
    is_composio_managed: true,
    status: "ENABLED",
    ...(flag === undefined ? {} : { is_enabled_for_tool_router: flag }),
    ...extra,
  });

  it("is switched on for every managed, enabled config that is off, before the session is made; others are left alone", async () => {
    const { composio } = open();
    configs = [
      managed("ac_late", true),
      managed("ac_off", false),
      managed("ac_off_too", false),
      managed("ac_unknown"),
      managed("ac_custom", false, { is_composio_managed: false }),
      managed("ac_disabled", false, { status: "DISABLED" }),
    ];
    await composio.sync(["gmail"]);
    expect(patches().map((one) => one.path)).toEqual([
      "/api/v3/auth_configs/ac_off",
      "/api/v3/auth_configs/ac_off_too",
    ]);
    for (const one of patches())
      expect(JSON.parse(one.body)).toEqual({
        type: "default",
        is_enabled_for_tool_router: true,
      });
    const asked = seen.find((one) =>
      one.path.startsWith("/api/v3/auth_configs?"),
    )!;
    expect(asked.path).toContain("toolkit_slug=gmail");
    expect(asked.path).toContain("is_composio_managed=true");
    expect(seen.indexOf(patches()[0]!)).toBeLessThan(seen.indexOf(posts()[0]!));
    expect(composio.has("@composio/gmail")).toBe(true);
    // Nothing is deleted on Composio.
    expect(seen.some((one) => one.method === "DELETE")).toBe(false);
  });

  it("sends no PATCH when every config is on or does not say", async () => {
    const { composio } = open();
    configs = [managed("ac_a", true), managed("ac_b")];
    await composio.sync(["gmail"]);
    expect(patches()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  it("is checked once for a toolkit, not again when its session is already there", async () => {
    const { composio } = open();
    configs = [managed("ac_off", false)];
    await composio.sync(["gmail"]);
    await composio.sync(["gmail"]);
    expect(patches()).toHaveLength(1);
    expect(
      seen.filter((one) => one.path.startsWith("/api/v3/auth_configs?")),
    ).toHaveLength(1);
  });

  it("does not hold the session back when the list or the PATCH fails: it is made, the log says so, and no key is in it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { composio } = open();
    configs = [managed("ac_off", false)];
    patchAnswer = () => json({ message: `no ${KEY}` }, 500);
    await composio.sync(["gmail"]);
    expect(composio.has("@composio/gmail")).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_0123");
    configs = undefined;
    warn.mockClear();
    await composio.sync(["gmail", "notion"]);
    expect(composio.has("@composio/notion")).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_0123");
  });
});
