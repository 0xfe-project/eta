/**
 * The `toolkits` section of the `plugins` target: the connected toolkits as the host lists them as
 * plugins of the agents (`@composio/<slug>`). The client reads it instead of asking again, so a
 * session that is made after the page opened reaches it as a push. Against a local fake of
 * backend.composio.dev and a fake key; nothing reaches the network.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Composio } from "../src/plugins/composio";
import { CatalogCache } from "../src/plugins/market-cache";
import { pluginsPlugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/service";
import { SettingStore } from "../src/settings/store";

const KEY = "ck_test_SECRET_0123456789";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

let server: ReturnType<typeof Bun.serve>;
let counter: number;
/** The fake answers a session only once this is released: the window before the sessions are made. */
let release: () => void;
let gate: Promise<void>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeEach(() => {
  counter = 0;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      if (url.pathname === "/api/v3/auth_configs")
        return json({ items: [], next_cursor: null });
      if (url.pathname === "/api/v3/connected_accounts")
        return json({
          items: ["gmail", "notion"].map((slug, index) => ({
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
        await gate;
        const id = `sess-${++counter}`;
        return json(
          {
            session_id: id,
            mcp: { type: "http", url: `${base()}/tool_router/${id}/mcp` },
            config: {
              toolkits: { enabled: parsed.toolkits.enable },
              manage_connections: { enable_connection_removal: false },
              workbench: { enable: false },
            },
            warnings: [],
          },
          201,
        );
      }
      return json({}, 404);
    },
  });
});
afterEach(async () => {
  await server.stop(true);
});

interface Projected {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
}

/** The host as product.ts makes it up to the `void follow()` of the start, with the plugins target's state captured. */
function boot() {
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
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
  const composio = new Composio({
    db,
    key: Buffer.alloc(32, 7),
    settings: new SettingStore(db),
    cache: new CatalogCache(db, { maxRowBytes: 1024 * 1024 }),
    baseUrl: base(),
  });
  composio.setKey(KEY);
  const projects = new Map<string, () => Projected>();
  const wire = new Proxy(
    {
      handle: () => () => {},
      stateOf: (target: string, options: { project: () => Projected }) => {
        projects.set(target, options.project);
        return () => {};
      },
    } as Record<string, unknown>,
    { get: (self, key: string) => self[key] ?? (() => () => {}) },
  );
  pluginsPlugin(
    { plugins, agents: {} as never, market: {} as never, composio },
    () => {},
  ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
  plugins.setVirtual(composio);
  const synced = new Promise<void>((resolve) => composio.onChange(resolve));
  return {
    plugins,
    composio,
    synced,
    /** What the host would send for the plugins target now. */
    state: (): Projected => projects.get("plugins")!(),
  };
}

const named = (section: unknown) =>
  (section as { name: string; enabled: boolean }[]).map(
    (one) => [one.name, one.enabled] as const,
  );

describe("the toolkits section of the plugins target", () => {
  it("is empty before the sessions are made and lists every connected toolkit once they are", async () => {
    const { composio, synced, state } = boot();
    const followed = composio.follow();
    await followed;
    const before = state();
    release();
    await synced;
    const after = state();

    expect(before.sections.toolkits).toEqual([]);
    expect(named(after.sections.toolkits)).toEqual([
      ["@composio/gmail", true],
      ["@composio/notion", true],
    ]);
    // Each entry says which provider the toolkit comes from; only Composio exists for now.
    expect(
      (after.sections.toolkits as { provider: string }[]).map(
        (one) => one.provider,
      ),
    ).toEqual(["composio", "composio"]);
    // The pipe sends a section whose revision moved: this is what pushes the list down.
    expect(after.revisions.toolkits).not.toBe(before.revisions.toolkits);
  });

  it("follows the user's switch of a toolkit", async () => {
    const { composio, plugins, synced, state } = boot();
    await composio.follow();
    release();
    await synced;
    const on = state();
    plugins.setEnabled("@composio/gmail", false);
    const off = state();

    expect(named(off.sections.toolkits)).toEqual([
      ["@composio/gmail", false],
      ["@composio/notion", true],
    ]);
    expect(off.revisions.toolkits).not.toBe(on.revisions.toolkits);
  });

  it("is empty, and does not throw, when the source is off, and holds nothing of the key", async () => {
    const { composio, synced, state } = boot();
    await composio.follow();
    release();
    await synced;
    const listed = JSON.stringify(state().sections.toolkits);
    composio.setEnabled(false);

    expect(listed).not.toContain(KEY);
    expect(state().sections.toolkits).toEqual([]);
  });
});
