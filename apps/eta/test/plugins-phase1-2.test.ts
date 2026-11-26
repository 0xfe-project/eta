/**
 * Phase 1 & 2 backend plugin/market/composio/agent-plugin regression tests:
 * - Startup restore() respects stored `plugins.githubProxy`
 * - `PluginRows.saveSource` updates `rev`, and `removeSource` cleans up all plugin rows
 * - Local-vs-git `${key}@git` collision update & remove, and `isServerPlugin` foreign manifests
 * - Composio >1 MiB toolkit catalog caching (8 MiB row / 16 MiB total)
 * - Granular `checkPlugins` error messages
 * - Virtual plugin `skippedPlugins` for remote daemon eta agents (while primary & external runtimes stay supported)
 * - `setLevel` invalidates `stampOf` immediately
 * - Live `plugins` wire notifications on Composio state changes (`sections.toolkits`)
 */
import type { PluginToolkitView } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPlugins } from "../src/agents/create";
import { AgentStore } from "../src/agents/store";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { MachineStore } from "../src/machines/store";
import { Composio } from "../src/plugins/composio";
import { githubProxy } from "../src/plugins/git";
import { PROXY_KEY } from "../src/plugins/market";
import { CatalogCache } from "../src/plugins/market-cache";
import { Plugins } from "../src/plugins/service";
import { SettingStore } from "../src/settings/store";
import { until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const FIXTURE = fileURLToPath(
  new URL("./fixtures/plugins/hello-plugin/", import.meta.url),
);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  githubProxy.prefix = "";
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
  return out.trim();
}

async function makePluginsEnv() {
  const dataDir = await tempDir("eta-p12-");
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  applyMigrations(db, loadMigrations());
  const agents = new AgentStore(db);
  const machines = new MachineStore(db);
  machines.ensurePrimary({ name: "primary", home: "/home/u", os: "linux" });
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 3),
    agents,
    machines,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  return { dataDir, db, agents, machines, plugins };
}

const count = (db: Database, table: string, where: string, value: string) =>
  db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`,
    )
    .get(value)!.n;

describe("plugin rows saveSource & removeSource", () => {
  it("updates rev on saveSource conflict and deletes plugin_config, plugin_agent_level and agent_plugin on removeSource", async () => {
    const { db, agents, plugins } = await makePluginsEnv();
    const ada = agents.create({ name: "Ada", model: "openai:gpt-5" });
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);

    plugins.rows.saveSource({
      name: "demo",
      repo: "https://example.com/r.git",
      rev: sha1,
      path: "",
      sha: sha1,
      ref: null,
    });
    plugins.rows.saveSource({
      name: "demo",
      repo: "https://example.com/r.git",
      rev: "main",
      path: "",
      sha: sha2,
      ref: "refs/heads/main",
    });
    expect(plugins.rows.source("demo")).toMatchObject({
      rev: "main",
      sha: sha2,
      ref: "refs/heads/main",
    });

    plugins.rows.saveValues("demo", { api_key: "secret-123" });
    plugins.rows.saveLevel("demo", "api_key", "none");
    plugins.rows.setEnabled(ada.id, ["demo"]);
    plugins.rows.setDisabled("demo", true);

    plugins.rows.removeSource("demo");
    expect(plugins.rows.source("demo")).toBeUndefined();
    expect(count(db, "plugin_config", "plugin", "demo")).toBe(0);
    expect(count(db, "plugin_agent_level", "plugin", "demo")).toBe(0);
    expect(count(db, "agent_plugin", "plugin", "demo")).toBe(0);
    expect(count(db, "plugin_disabled", "plugin", "demo")).toBe(0);
    expect(plugins.rows.enabled(ada.id)).toEqual([]);
    expect(plugins.skipped(ada.id)).toEqual([]);
  });
});

describe("startup restore() respects plugins.githubProxy", () => {
  it("loads stored plugins.githubProxy before plugins.start() restores missing git sources", async () => {
    const dataDir = await tempDir("eta-proxy-boot-");
    const dbPath = databasePath(dataDir);
    const proxyPrefix = "http://127.0.0.1:1/px/";
    const db = openDatabase(dbPath);
    applyMigrations(db, loadMigrations());
    new SettingStore(db).set(PROXY_KEY, proxyPrefix);
    db.query(
      `INSERT INTO plugin_source (name, repo, rev, path, sha, ref, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gh-plugin",
      "https://github.com/acme/missing-plugin.git",
      "main",
      "",
      "a".repeat(40),
      "refs/heads/main",
      Date.now(),
    );
    db.close();

    // Ensure prefix starts empty before product startup.
    githubProxy.prefix = "";
    const warnings: string[] = [];
    const host = await testHost({
      dataDir,
      warn: (message) => warnings.push(message),
    });
    cleanups.push(() => host.close());

    expect(githubProxy.prefix).toBe(proxyPrefix);
    // `fetchInto` only appends "(through the GitHub proxy)" if `githubProxy.prefix` was already set when `restore()` ran.
    expect(
      warnings.some(
        (line) =>
          line.includes("gh-plugin") &&
          line.includes("(through the GitHub proxy)"),
      ),
    ).toBe(true);
  });
});

describe("local-vs-git @git collision & isServerPlugin foreign layouts", () => {
  it("supports updating and removing a colliding <name>@git entry without wiping local config", async () => {
    const { dataDir, agents, plugins } = await makePluginsEnv();
    const ada = agents.create({ name: "Ada", model: "openai:gpt-5" });
    const repoDir = await tempDir("eta-collide-repo-");
    await git(repoDir, "init", "-q", "-b", "main");
    await git(repoDir, "config", "uploadpack.allowAnySHA1InWant", "true");
    await cp(FIXTURE, repoDir, { recursive: true });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-qm", "v1");
    const sha1 = await git(repoDir, "rev-parse", "HEAD");

    // Add from git first.
    expect(await plugins.registry.add(`file://${repoDir}`, "main", "")).toBe(
      "hello-plugin",
    );
    expect(plugins.registry.get("hello-plugin")?.source.kind).toBe("git");

    // Now drop a local plugin with the same name and configure/enable it.
    await cp(FIXTURE, join(dataDir, "plugins", "hello-plugin"), {
      recursive: true,
    });
    await plugins.registry.refresh();
    expect(plugins.registry.get("hello-plugin")?.source.kind).toBe("local");
    const colliding = plugins.registry.get("hello-plugin@git");
    expect(colliding).toMatchObject({
      name: "hello-plugin@git",
      source: { kind: "git", sha: sha1 },
      problem: "another plugin is named hello-plugin",
    });

    plugins.rows.saveValues("hello-plugin", { api_key: "sk-local-keep" });
    plugins.rows.setEnabled(ada.id, ["hello-plugin"]);

    // Advance the git repo and update via the colliding `@git` name.
    await writeFile(join(repoDir, "README.md"), "updated\n");
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-qm", "v2");
    const sha2 = await git(repoDir, "rev-parse", "HEAD");
    await plugins.registry.update("hello-plugin@git");
    expect(plugins.rows.source("hello-plugin")?.sha).toBe(sha2);

    // Removing the local name must be refused; removing `@git` removes only the git source.
    await expect(plugins.registry.remove("hello-plugin")).rejects.toThrow(
      /not from git/,
    );
    await plugins.registry.remove("hello-plugin@git");
    expect(plugins.registry.get("hello-plugin@git")).toBeUndefined();
    expect(plugins.registry.get("hello-plugin")?.source.kind).toBe("local");
    expect(plugins.rows.source("hello-plugin")).toBeUndefined();
    // Local plugin's config and agent bindings stay intact.
    expect(plugins.rows.values("hello-plugin")).toEqual({
      api_key: "sk-local-keep",
    });
    expect(plugins.rows.enabled(ada.id)).toEqual(["hello-plugin"]);
  });

  it("loads local directories with package.json[eta-plugin] when .claude-plugin or .cursor-plugin manifest exists", async () => {
    const { dataDir, plugins } = await makePluginsEnv();
    for (const [dirName, manifestDir] of [
      ["claude-both", ".claude-plugin"],
      ["cursor-both", ".cursor-plugin"],
    ] as const) {
      const dir = join(dataDir, "plugins", dirName);
      await mkdir(join(dir, manifestDir), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: dirName, "eta-plugin": "./index.js" }),
      );
      await writeFile(
        join(dir, manifestDir, "plugin.json"),
        JSON.stringify({ name: dirName, description: "Dual layout" }),
      );
    }
    await plugins.registry.refresh();
    expect(plugins.registry.get("claude-both")?.plugin?.manifest.name).toBe(
      "claude-both",
    );
    expect(plugins.registry.get("cursor-both")?.plugin?.manifest.name).toBe(
      "cursor-both",
    );
  });
});

describe("composio >1 MiB toolkit catalog caching", () => {
  it("caches a >1.5 MiB Composio toolkit list and serves read(cached), toolkitsOf, add and logoOf after restart", async () => {
    const filler = "x".repeat(450);
    // 3000 toolkits * ~600 bytes > 1.8 MiB (> old 1 MiB CatalogCache limit)
    const bigToolkits = Array.from({ length: 3000 }, (_, i) => ({
      slug: i === 0 ? "hackernews" : `toolkit_${i}`,
      name: i === 0 ? "Hacker News" : `Toolkit ${i}`,
      auth_schemes: i === 0 ? ["NO_AUTH"] : ["OAUTH2"],
      composio_managed_auth_schemes: i === 0 ? [] : ["OAUTH2"],
      no_auth: i === 0,
      meta: {
        description: `${filler}-${i}`,
        logo: `https://cdn.example.com/logo-${i}.png`,
      },
    }));
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v3/toolkits") {
          const offset = Number(url.searchParams.get("cursor") ?? 0);
          const page = bigToolkits.slice(offset, offset + 100);
          const next =
            offset + 100 < bigToolkits.length ? String(offset + 100) : null;
          return new Response(
            JSON.stringify({ items: page, next_cursor: next }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/v3.1/tool_router/session"
        ) {
          return new Response(
            JSON.stringify({
              session_id: "sess-hn",
              mcp: {
                type: "http",
                url: `http://127.0.0.1:${server.port}/tool_router/sess-hn/mcp`,
              },
              config: {
                toolkits: { enabled: ["hackernews"] },
                manage_connections: { enable_connection_removal: false },
                workbench: { enable: false },
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));

    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    applyMigrations(db, loadMigrations());
    const key = Buffer.alloc(32, 9);
    const make = () =>
      new Composio({
        db,
        key,
        settings: new SettingStore(db),
        cache: new CatalogCache(db, {
          maxRowBytes: 8 * 1024 * 1024,
          maxTotalBytes: 16 * 1024 * 1024,
        }),
        baseUrl: `http://127.0.0.1:${server.port}`,
      });

    const first = make();
    first.setKey("ck_test_large_cache_key");
    const refreshed = await first.read(first.source(), "refresh");
    expect(refreshed.toolkits).toHaveLength(3000);

    // Simulate a restart (fresh Composio instance on same DB).
    const second = make();
    const cached = await second.read(second.source(), "cached");
    expect(cached.toolkits).toHaveLength(3000);
    expect(second.toolkitsOf(["hackernews", "toolkit_2999"])).toHaveLength(2);
    expect(second.logoOf("toolkit_2999")).toBe(
      "https://cdn.example.com/logo-2999.png",
    );
    expect(await second.add("hackernews")).toEqual({ status: "ready" });
    expect(second.has("@composio/hackernews")).toBe(true);
  });
});

describe("granular checkPlugins, virtual skippedPlugins & setLevel stamp invalidation", () => {
  it("reports distinct actionable errors for missing, invalid manifest, needs config, and unready Composio toolkits", async () => {
    const { dataDir, plugins } = await makePluginsEnv();
    // 1. Invalid manifest plugin
    const brokenDir = join(dataDir, "plugins", "broken-plug");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "plugin.json"), "{not-json");
    // 2. Needs configuring plugin
    const cfgDir = join(dataDir, "plugins", "needs-cfg");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      join(cfgDir, "plugin.json"),
      JSON.stringify({
        $schema: PLUGIN_SCHEMA,
        name: "needs-cfg",
        extensions: {
          "tech.0xfe.eta": {
            config: {
              token: { type: "string", title: "Token", required: true },
            },
          },
        },
      }),
    );
    await plugins.registry.refresh();
    plugins.setVirtual({
      owns: (name) => name.startsWith("@composio/"),
      has: (name) => name === "@composio/gmail",
      mcpSource: () => undefined,
      identity: () => "sess-1",
      demand: () => {},
      refresh: () => {},
      toolkitsFor: () => [],
      secrets: () => [],
      onChange: () => {},
    });

    expect(() => checkPlugins(plugins, undefined, ["nope"])).toThrow(
      /not installed/,
    );
    expect(() => checkPlugins(plugins, undefined, ["broken-plug"])).toThrow(
      /manifest is invalid/,
    );
    expect(() => checkPlugins(plugins, undefined, ["needs-cfg"])).toThrow(
      /needs configuring/,
    );
    expect(() => checkPlugins(plugins, undefined, ["@composio/slack"])).toThrow(
      /not connected or ready/,
    );
    expect(() =>
      checkPlugins(plugins, undefined, ["@composio/gmail"]),
    ).not.toThrow();
  });

  it("surfaces @composio/* virtual plugins in skippedPlugins only for remote daemon eta agents", async () => {
    const { agents, machines, plugins } = await makePluginsEnv();
    const fingerprint = "a".repeat(64);
    const { code } = machines.enroll("remote-box");
    const daemon = machines.exchange({
      code,
      fingerprint,
      hostname: "remote-box",
      home: "/home/remote",
      os: "linux",
    });
    machines.approve(daemon.id, fingerprint);

    plugins.setVirtual({
      owns: (name) => name.startsWith("@composio/"),
      has: (name) => name === "@composio/gmail",
      mcpSource: (names) =>
        names.includes("@composio/gmail")
          ? {
              name: "composio",
              servers: {
                composio: {
                  type: "http",
                  url: "https://composio.example/mcp",
                },
              },
            }
          : undefined,
      identity: () => "sess-gmail",
      demand: () => {},
      refresh: () => {},
      toolkitsFor: () => [],
      secrets: () => [],
      onChange: () => {},
    });

    const primaryEta = agents.create({
      name: "PrimaryEta",
      runtime: "eta",
      model: "openai:gpt-5",
    });
    const externalClaude = agents.create({
      name: "ExternalClaude",
      runtime: "claude",
      model: null,
    });
    const remoteDaemonClaude = agents.create({
      name: "RemoteDaemonClaude",
      runtime: "claude",
      model: null,
      machineId: daemon.id,
    });
    const remoteDaemonEta = agents.create({
      name: "RemoteDaemon",
      runtime: "eta",
      model: "openai:gpt-5",
      machineId: daemon.id,
    });

    for (const agent of [
      primaryEta,
      externalClaude,
      remoteDaemonClaude,
      remoteDaemonEta,
    ])
      plugins.rows.setEnabled(agent.id, ["@composio/gmail"]);

    expect(plugins.skipped(primaryEta.id)).toEqual([]);
    expect(plugins.mcpSourcesFor(primaryEta.id)).toHaveLength(1);

    expect(plugins.skipped(externalClaude.id)).toEqual([]);
    expect(plugins.toolkitServersFor(externalClaude.id)).toHaveLength(1);

    expect(plugins.skipped(remoteDaemonClaude.id)).toEqual([]);
    expect(plugins.toolkitServersFor(remoteDaemonClaude.id)).toHaveLength(1);

    expect(plugins.skipped(remoteDaemonEta.id)).toEqual(["@composio/gmail"]);
    expect(plugins.stampOf(remoteDaemonEta.id)).toBe("");
  });

  it("invalidates stampOf when setLevel modifies plugin_agent_level", async () => {
    const { dataDir, agents, plugins } = await makePluginsEnv();
    const dir = join(dataDir, "plugins", "secret-plug");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({
        $schema: PLUGIN_SCHEMA,
        name: "secret-plug",
        extensions: {
          "tech.0xfe.eta": {
            config: {
              api_key: {
                type: "string",
                title: "API Key",
                required: true,
                secret: true,
                agent: "value",
              },
            },
          },
        },
      }),
    );
    await plugins.registry.refresh();
    plugins.configure("secret-plug", { api_key: "top-secret" });
    const ada = agents.create({ name: "Ada", model: "openai:gpt-5" });
    plugins.rows.setEnabled(ada.id, ["secret-plug"]);

    const initial = plugins.stampOf(ada.id);
    plugins.setLevel("secret-plug", "api_key", "none");
    const lowered = plugins.stampOf(ada.id);
    expect(lowered).not.toBe(initial);

    plugins.setLevel("secret-plug", "api_key", "file");
    const raised = plugins.stampOf(ada.id);
    expect(raised).not.toBe(lowered);
    expect(raised).not.toBe(initial);

    // Restoring default matches the initial stamp again.
    plugins.setLevel("secret-plug", "api_key", "value");
    expect(plugins.stampOf(ada.id)).toBe(initial);
  });
});

describe("composio wire notifications on plugins target", () => {
  it("notifies listeners on key, add, remove and disconnect changes and pushes sections.composio live", async () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    applyMigrations(db, loadMigrations());
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v3/toolkits")
          return new Response(
            JSON.stringify({
              items: [
                {
                  slug: "hackernews",
                  name: "Hacker News",
                  no_auth: true,
                  auth_schemes: ["NO_AUTH"],
                  composio_managed_auth_schemes: [],
                  meta: {},
                },
              ],
              next_cursor: null,
            }),
            { headers: { "content-type": "application/json" } },
          );
        if (
          request.method === "POST" &&
          url.pathname === "/api/v3.1/tool_router/session"
        )
          return new Response(
            JSON.stringify({
              session_id: "sess-1",
              mcp: {
                type: "http",
                url: `http://127.0.0.1:${server.port}/tool_router/sess-1/mcp`,
              },
              config: {
                toolkits: { enabled: ["hackernews"] },
                manage_connections: { enable_connection_removal: false },
                workbench: { enable: false },
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        return new Response("{}", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));

    const composio = new Composio({
      db,
      key: Buffer.alloc(32, 5),
      settings: new SettingStore(db),
      cache: new CatalogCache(db, { maxRowBytes: 8 * 1024 * 1024 }),
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    let notifications = 0;
    const off = composio.onChange(() => {
      notifications++;
    });

    composio.setKey("ck_test_notify_key");
    expect(notifications).toBe(1);
    await composio.read(composio.source(), "refresh");
    await composio.add("hackernews");
    expect(notifications).toBe(2);
    composio.remove("hackernews");
    expect(notifications).toBe(3);
    composio.clearKey();
    expect(notifications).toBe(4);

    off();
    composio.setKey("ck_test_notify_key_2");
    expect(notifications).toBe(4);

    // Also verify the live `plugins` target publishes the `toolkits` section over the wire.
    const w = await world();
    w.client.subscribe("plugins");
    await until(
      () =>
        w.client.section<PluginToolkitView[]>("plugins", "toolkits") !==
        undefined,
    );
    expect(
      w.client.section<PluginToolkitView[]>("plugins", "toolkits"),
    ).toEqual([]);
    // Reject adding an unready `@composio/*` toolkit over the wire with a granular reason.
    await expect(
      w.client.call("agents", "create", {
        name: "ExtAgent",
        runtime: "claude",
        plugins: ["@composio/gmail"],
      }),
    ).rejects.toThrow(/not connected or ready/);
    const ext = await w.agent("ExtOk", { runtime: "claude", model: null });
    await expect(
      w.client.call("agents", "update", {
        agentId: ext.id,
        plugins: ["@composio/gmail"],
      }),
    ).rejects.toThrow(/not connected or ready/);
  });
});
