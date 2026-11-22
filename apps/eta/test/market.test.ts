/**
 * The plugin market against a local catalog server and a local git repository: nothing here
 * reaches the network. The registry is the real one, so an install is the real git-source add.
 */
import type { MarketCatalog } from "@eta/client-contracts";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import {
  CATALOG_URL_KEY,
  DEFAULT_CATALOG_URL,
  Market,
} from "../src/plugins/market";
import { PluginRegistry } from "../src/plugins/registry";
import { PluginRows } from "../src/plugins/store";
import { SettingStore } from "../src/settings/store";
import { tempDir } from "./support/host";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/plugins/hello-plugin/", import.meta.url),
);
const NAME = "hello-plugin";

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

/**
 * A repository with the fixture plugin under `sub`, and a Cursor-layout plugin (manifest in
 * `.cursor-plugin/`, a skill, and an `agents/` folder eta does not load) under `cursor`.
 */
async function repo(): Promise<{ url: string; sha: string }> {
  const dir = await tempDir("eta-market-repo-");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  await cp(FIXTURE, join(dir, "sub"), { recursive: true });
  const foreign = join(dir, "cursor");
  await mkdir(join(foreign, ".cursor-plugin"), { recursive: true });
  await mkdir(join(foreign, "skills", "a"), { recursive: true });
  await mkdir(join(foreign, "agents"), { recursive: true });
  await writeFile(
    join(foreign, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "cursor-demo",
      displayName: "Cursor demo",
      skills: "./skills/",
      agents: "./agents/",
    }),
  );
  await writeFile(
    join(foreign, "skills", "a", "SKILL.md"),
    "---\nname: a\ndescription: Does a things.\n---\n\nBody.\n",
  );
  await writeFile(join(foreign, "agents", "x.md"), "x");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "first");
  return { url: `file://${dir}`, sha: await git(dir, "rev-parse", "HEAD") };
}

let handler: (request: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
});
afterEach(async () => {
  await server.stop(true);
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

async function market(
  options: { maxBytes?: number; timeoutMs?: number; catalogRepo?: string } = {},
) {
  const dataDir = await tempDir("eta-market-");
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  const rows = new PluginRows(db, Buffer.alloc(32, 1));
  const registry = new PluginRegistry({
    dataDir,
    rows,
    changed: () => {},
    warn: () => {},
  });
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  const settings = new SettingStore(db);
  const instance = new Market({
    settings,
    plugins: { registry } as never,
    dataDir,
    schemes: ["https:", "file:"],
    ...options,
  });
  const url = `http://127.0.0.1:${server.port}/catalog.json`;
  return { market: instance, settings, registry, url };
}

const SHA = "a".repeat(40);
const item = (over: Record<string, unknown> = {}) => ({
  name: NAME,
  description: "Says hello",
  author: { name: "t" },
  source: {
    source: "git-subdir",
    url: "https://example.com/r.git",
    path: "sub",
    ref: "main",
    sha: SHA,
  },
  ...over,
});
const sourceOf = (over: Record<string, unknown>) => ({
  source: {
    source: "git-subdir",
    url: "https://example.com/r.git",
    path: "sub",
    sha: SHA,
    ...over,
  },
});

describe("the catalog", () => {
  it("defaults to Cursor's public list, says so when the address is empty, and applies a new one at once", async () => {
    expect(DEFAULT_CATALOG_URL).toBe(
      "https://raw.githubusercontent.com/cursor/plugins/HEAD/.cursor-plugin/marketplace.json",
    );
    const m = await market();
    m.settings.set(CATALOG_URL_KEY, "");
    expect(await m.market.catalog()).toMatchObject({
      url: "",
      isDefault: false,
      entries: null,
      error: "no catalog address is set",
    });
    handler = () => json({ plugins: [item()] });
    const set = await m.market.setUrl(m.url);
    expect(set).toMatchObject({ url: m.url, isDefault: false, error: null });
    expect(set.entries?.map((e) => e.name)).toEqual([NAME]);
    expect(m.settings.get(CATALOG_URL_KEY)).toBe(m.url);
    await expect(m.market.setUrl("file:///etc/passwd")).rejects.toThrow(
      /not an http\(s\) URL/,
    );
  });

  it("reads the three kinds of source: a path in the catalog's repository, url, and git-subdir", async () => {
    handler = () =>
      json({
        metadata: { pluginRoot: "./plugins" },
        plugins: [
          { name: "relative", description: "d", source: "./a" },
          {
            name: "by-url",
            description: "d",
            author: "someone",
            version: "2.0.0",
            homepage: "https://example.com",
            source: { source: "url", url: "https://example.com/u.git", sha: SHA },
          },
          item({ name: "by-subdir" }),
          {
            name: "by-url-no-sha",
            description: "d",
            source: { source: "url", url: "https://example.com/u.git", ref: "v1" },
          },
        ],
      });
    const m = await market({ catalogRepo: "https://example.com/c.git" });
    const c = await m.market.setUrl(m.url);
    expect(c.rejected).toEqual([]);
    const by = Object.fromEntries(c.entries!.map((e) => [e.name, e]));
    expect(by.relative).toMatchObject({
      repo: "https://example.com/c.git",
      path: "plugins/a",
      rev: null,
      unsupported: null,
    });
    expect(by["by-url"]).toMatchObject({
      repo: "https://example.com/u.git",
      path: "",
      rev: SHA,
      author: "someone",
      version: "2.0.0",
      homepage: "https://example.com",
    });
    expect(by["by-subdir"]).toMatchObject({
      repo: "https://example.com/r.git",
      path: "sub",
      rev: SHA,
      author: "t",
    });
    expect(by["by-url-no-sha"]).toMatchObject({ rev: null });
  });

  it("reads a relative source with no pluginRoot, with or without ./", async () => {
    handler = () =>
      json({
        plugins: [
          { name: "plain", description: "d", source: "plain" },
          { name: "dotted", description: "d", source: "./plugins/dotted" },
        ],
      });
    const m = await market({ catalogRepo: "https://example.com/c.git" });
    const c = await m.market.setUrl(m.url);
    expect(c.rejected).toEqual([]);
    expect(c.entries!.map((e) => e.path)).toEqual(["plain", "plugins/dotted"]);
  });

  it("marks a source eta does not read as unsupported, and does not hide it", async () => {
    handler = () =>
      json({
        plugins: [
          item(),
          { name: "cmd", description: "d", source: { source: "command", command: "x" } },
          { name: "gh", description: "d", source: { source: "github", repo: "a/b" } },
          { name: "nosource", description: "d" },
        ],
      });
    const m = await market();
    const c = await m.market.setUrl(m.url);
    expect(c.entries?.map((e) => e.name)).toEqual([NAME, "cmd", "gh", "nosource"]);
    const cmd = c.entries!.find((e) => e.name === "cmd")!;
    expect(cmd.unsupported).toMatch(/format not supported: source "command"/);
    expect(c.entries![0]!.unsupported).toBeNull();
    await expect(m.market.preview("cmd")).rejects.toThrow(/format not supported/);
    await expect(m.market.install("cmd", SHA)).rejects.toThrow(/format not supported/);
  });

  it("drops the entries that do not fit, with the reason", async () => {
    handler = () =>
      json({
        plugins: [
          item(),
          item({ name: "branchy", ...sourceOf({ sha: "main" }) }),
          item({ name: "short", ...sourceOf({ sha: "abc1234" }) }),
          item({ name: "upper", ...sourceOf({ sha: "A".repeat(40) }) }),
          item({ name: "Bad Name" }),
          item({ name: "dash", ...sourceOf({ url: "--upload-pack=x" }) }),
          item({ name: "local", ...sourceOf({ url: "/etc/passwd" }) }),
          item({ name: "escapes", ...sourceOf({ path: "../up" }) }),
          "nope",
          item(),
        ],
      });
    const m = await market();
    const catalog = await m.market.setUrl(m.url);
    expect(catalog.error).toBeNull();
    expect(catalog.entries?.map((e) => e.name)).toEqual([NAME]);
    const why = Object.fromEntries(
      catalog.rejected.map((r) => [r.name ?? `#${r.index}`, r.reason]),
    );
    expect(why.branchy).toMatch(/40 lowercase hex/);
    expect(why.short).toMatch(/40 lowercase hex/);
    expect(why.upper).toMatch(/40 lowercase hex/);
    expect(why["Bad Name"]).toMatch(/invalid name/);
    expect(why.dash).toMatch(/not a repository address/);
    expect(why.local).toMatch(/not a repository address/);
    expect(why.escapes).toBeDefined();
    expect(why["#9"]).toMatch(/must be an object/);
    expect(why[NAME]).toMatch(/listed twice/);
  });

  async function failure(
    over: Parameters<typeof market>[0],
  ): Promise<MarketCatalog> {
    const m = await market(over);
    return await m.market.setUrl(m.url);
  }

  it("refuses a catalog that is too big", async () => {
    handler = () =>
      json({ plugins: [item({ description: "x".repeat(400) })] });
    const c = await failure({ maxBytes: 100 });
    expect(c.entries).toBeNull();
    expect(c.error).toMatch(/larger than 100 bytes/);
  });

  it("refuses a catalog that is too big with no length announced", async () => {
    handler = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(500)));
            controller.close();
          },
        }),
      );
    const c = await failure({ maxBytes: 100 });
    expect(c.error).toMatch(/larger than 100 bytes/);
  });

  it("gives up on a catalog that does not answer", async () => {
    handler = async () => {
      await Bun.sleep(1000);
      return json({ plugins: [] });
    };
    const c = await failure({ timeoutMs: 100 });
    expect(c.entries).toBeNull();
    expect(c.error).toMatch(/no answer in 100 ms/);
  });

  it("reports JSON that is not JSON, a wrong shape, and an HTTP error", async () => {
    handler = () => new Response("{nope");
    expect((await failure({})).error).toBe("the catalog is not valid JSON");
    handler = () => json([1, 2]);
    expect((await failure({})).error).toMatch(/"plugins" list/);
    handler = () => new Response("gone", { status: 404 });
    expect((await failure({})).error).toMatch(/HTTP 404/);
  });

  it("is an answer when the server is down, and leaves installed plugins alone", async () => {
    const { url: repoUrl, sha } = await repo();
    handler = () =>
      json({
        plugins: [item({ ...sourceOf({ url: repoUrl, sha }) })],
      });
    const m = await market();
    await m.market.setUrl(m.url);
    await m.market.install(NAME, sha);
    await server.stop(true);
    const down = await m.market.catalog();
    expect(down.entries).toBeNull();
    expect(down.error).toMatch(/cannot read the catalog/);
    expect(m.registry.get(NAME)).toBeDefined();
  });
});

describe("installing from the catalog", () => {
  it("previews what the plugin runs, installs at the pinned commit, and marks it installed", async () => {
    const { url, sha } = await repo();
    handler = () =>
      json({ plugins: [item({ name: "hello-catalog", ...sourceOf({ url, sha }) })] });
    const m = await market();
    await m.market.setUrl(m.url);

    const preview = await m.market.preview("hello-catalog");
    expect(preview).toMatchObject({ repo: url, path: "sub", sha });
    expect(preview.servers.length).toBeGreaterThan(0);
    expect(preview.servers[0]!.command?.length).toBeGreaterThan(0);
    expect(preview.servers[0]!.env.length).toBeGreaterThan(0);
    expect(preview.fields.some((field) => field.secret)).toBe(true);
    // A preview installs nothing.
    expect(m.registry.get(NAME)).toBeUndefined();
    expect((await m.market.catalog()).entries![0]!.installed).toBe("no");

    // The plugin keeps the name its manifest gives it, not the catalog's.
    expect(await m.market.install("hello-catalog", sha)).toBe(NAME);
    expect(m.registry.get(NAME)!.source).toMatchObject({
      kind: "git",
      repo: url,
      path: "sub",
      sha,
    });
    expect((await m.market.catalog()).entries![0]!.installed).toBe("this");
    await expect(m.market.install("hello-catalog", sha)).rejects.toThrow(
      /installed/,
    );
  });

  it("resolves the repository's commit for an entry without a sha, and installs that commit", async () => {
    const { url, sha } = await repo();
    handler = () =>
      json({
        metadata: { pluginRoot: "." },
        plugins: [{ name: "hello-rel", description: "d", source: "./sub" }],
      });
    const m = await market({ catalogRepo: url });
    await m.market.setUrl(m.url);
    const listed = (await m.market.catalog()).entries![0]!;
    expect(listed).toMatchObject({ repo: url, path: "sub", rev: null });
    const preview = await m.market.preview("hello-rel");
    expect(preview.sha).toBe(sha);
    await m.market.install("hello-rel", preview.sha);
    expect(m.registry.get(NAME)!.source).toMatchObject({ sha, path: "sub" });
  });

  it("previews a Cursor-layout plugin: skills load, what is ignored is listed", async () => {
    const { url, sha } = await repo();
    handler = () =>
      json({
        plugins: [
          { name: "cursor-demo", description: "d", source: { source: "git-subdir", url, path: "cursor", sha } },
        ],
      });
    const m = await market();
    await m.market.setUrl(m.url);
    const preview = await m.market.preview("cursor-demo");
    expect(preview.skills.map((s) => s.name)).toEqual(["a"]);
    expect(preview.servers).toEqual([]);
    const reports = preview.reports.join("\n");
    expect(reports).toContain("manifest read from .cursor-plugin/plugin.json");
    expect(reports).toContain("agents is not supported by eta; ignored");
    expect(reports).toContain("agents/: not supported by eta; ignored");
    expect(await m.market.install("cursor-demo", sha)).toBe("cursor-demo");
  });

  it("does not install when the catalog moved to another commit since the user looked", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [item({ ...sourceOf({ url, sha }) })] });
    const m = await market();
    await m.market.setUrl(m.url);
    handler = () =>
      json({ plugins: [item({ ...sourceOf({ url, sha: "b".repeat(40) }) })] });
    await expect(m.market.install(NAME, sha)).rejects.toThrow(/look at it again/);
    expect(m.registry.get(NAME)).toBeUndefined();
    await expect(m.market.install(NAME, "main")).rejects.toThrow(/commit hash/);
  });

  it("does not preview a plugin that is not in the catalog", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [item({ ...sourceOf({ url, sha }) })] });
    const m = await market();
    await m.market.setUrl(m.url);
    await expect(m.market.preview("missing")).rejects.toThrow(/not in the catalog/);
  });
});
