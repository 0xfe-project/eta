/**
 * The plugin market against a local catalog server and a local git repository: nothing here
 * reaches the network. The registry is the real one, so an install is the real git-source add.
 */
import type { MarketCatalog } from "@eta/client-contracts";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { CATALOG_URL_KEY, Market } from "../src/plugins/market";
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

/** A repository with the fixture plugin under `sub`, and the commit it is at. */
async function repo(): Promise<{ url: string; sha: string }> {
  const dir = await tempDir("eta-market-repo-");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  await cp(FIXTURE, join(dir, "sub"), { recursive: true });
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

async function market(options: { maxBytes?: number; timeoutMs?: number } = {}) {
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
const entry = (over: Record<string, unknown> = {}) => ({
  name: NAME,
  description: "Says hello",
  author: "t",
  version: "1.0.0",
  repo: "https://example.com/r.git",
  path: "sub",
  rev: SHA,
  ...over,
});

describe("the catalog", () => {
  it("says so when no address is set, and applies a new one at once", async () => {
    const m = await market();
    const none = await m.market.catalog();
    expect(none).toMatchObject({
      url: "",
      isDefault: true,
      entries: null,
      error: "no catalog address is set",
    });
    handler = () => json({ plugins: [entry()] });
    const set = await m.market.setUrl(m.url);
    expect(set).toMatchObject({ url: m.url, isDefault: false, error: null });
    expect(set.entries?.map((e) => e.name)).toEqual([NAME]);
    expect(m.settings.get(CATALOG_URL_KEY)).toBe(m.url);
    expect((await m.market.setUrl("")).url).toBe("");
    await expect(m.market.setUrl("file:///etc/passwd")).rejects.toThrow(
      /not an http\(s\) URL/,
    );
  });

  it("lists a good catalog and drops the entries that do not fit, with the reason", async () => {
    handler = () =>
      json({
        plugins: [
          entry(),
          entry({ name: "no-rev", rev: undefined }),
          entry({ name: "branchy", rev: "main" }),
          entry({ name: "short", rev: "abc1234" }),
          entry({ name: "upper", rev: "A".repeat(40) }),
          entry({ name: "Bad Name" }),
          entry({ name: "dup-ssh", repo: "--upload-pack=x" }),
          entry({ name: "local", repo: "/etc/passwd" }),
          entry({ name: "nodesc", description: "" }),
          entry({ name: "escapes", path: "../up" }),
          entry({ name: "cmds", requires: ["ok", "rm -rf /"] }),
          entry({ name: "home", homepage: "javascript:alert(1)" }),
          "nope",
          entry(),
        ],
      });
    const m = await market();
    const catalog = await (await (async () => {
      await m.market.setUrl(m.url);
      return m.market;
    })()).catalog();
    expect(catalog.error).toBeNull();
    expect(catalog.entries?.map((e) => e.name)).toEqual([NAME]);
    const why = Object.fromEntries(
      catalog.rejected.map((r) => [r.name ?? `#${r.index}`, r.reason]),
    );
    expect(why["no-rev"]).toMatch(/rev is missing/);
    expect(why.branchy).toMatch(/40 lowercase hex/);
    expect(why.short).toMatch(/40 lowercase hex/);
    expect(why.upper).toMatch(/40 lowercase hex/);
    expect(why["Bad Name"]).toMatch(/invalid name/);
    expect(why["dup-ssh"]).toMatch(/not a repository address/);
    expect(why.local).toMatch(/not a repository address/);
    expect(why.nodesc).toMatch(/description is missing/);
    expect(why.escapes).toBeDefined();
    expect(why.cmds).toMatch(/command names/);
    expect(why.home).toMatch(/not an http\(s\) URL/);
    expect(why["#13"]).toMatch(/must be an object/);
    expect(why[NAME]).toMatch(/listed twice/);
  });

  async function failure(over: Parameters<typeof market>[0]): Promise<MarketCatalog> {
    const m = await market(over);
    return await m.market.setUrl(m.url);
  }

  it("refuses a catalog that is too big", async () => {
    handler = () => json({ plugins: [entry({ description: "x".repeat(400) })] });
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
    handler = () => json({ plugins: [entry({ repo: repoUrl, rev: sha })] });
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
    handler = () => json({ plugins: [entry({ repo: url, rev: sha })] });
    const m = await market();
    await m.market.setUrl(m.url);

    const preview = await m.market.preview(NAME);
    expect(preview).toMatchObject({ name: NAME, repo: url, path: "sub", sha });
    expect(preview.servers.length).toBeGreaterThan(0);
    expect(preview.servers[0]!.command?.length).toBeGreaterThan(0);
    expect(preview.servers[0]!.env.length).toBeGreaterThan(0);
    expect(preview.fields.some((field) => field.secret)).toBe(true);
    // A preview installs nothing.
    expect(m.registry.get(NAME)).toBeUndefined();
    expect((await m.market.catalog()).entries![0]!.installed).toBe("no");

    expect(await m.market.install(NAME, sha)).toBe(NAME);
    const source = m.registry.get(NAME)!.source;
    expect(source).toMatchObject({ kind: "git", repo: url, path: "sub", sha });
    expect((await m.market.catalog()).entries![0]!.installed).toBe("this");
    await expect(m.market.install(NAME, sha)).rejects.toThrow(/installed/);
  });

  it("does not install when the catalog moved to another commit since the user looked", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [entry({ repo: url, rev: sha })] });
    const m = await market();
    await m.market.setUrl(m.url);
    handler = () => json({ plugins: [entry({ repo: url, rev: "b".repeat(40) })] });
    await expect(m.market.install(NAME, sha)).rejects.toThrow(/look at it again/);
    expect(m.registry.get(NAME)).toBeUndefined();
  });

  it("does not install a plugin that is not in the catalog, or one named otherwise", async () => {
    const { url, sha } = await repo();
    handler = () =>
      json({ plugins: [entry({ name: "other-name", repo: url, rev: sha })] });
    const m = await market();
    await m.market.setUrl(m.url);
    await expect(m.market.preview("missing")).rejects.toThrow(/not in the catalog/);
    await expect(m.market.preview("other-name")).rejects.toThrow(
      /the catalog says other-name/,
    );
    expect(m.registry.get(NAME)).toBeUndefined();
  });
});
