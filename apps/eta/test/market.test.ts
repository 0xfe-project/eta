import type { MarketEntry, MarketRejected } from "@eta/client-contracts";
/**
 * The plugin market against a local catalog server and a local git repository: nothing here
 * reaches the network. The registry is the real one, so an install is the real git-source add.
 */
import { Buffer } from "node:buffer";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { githubProxy, normalizeProxy, viaProxy } from "../src/plugins/git";
import {
  DEFAULT_SOURCES,
  LEGACY_URL_KEY,
  Market,
  PROXY_KEY,
  SOURCES_KEY,
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

/** One source's catalog, flat: what most tests look at. */
interface Flat {
  url: string;
  entries: MarketEntry[] | null;
  rejected: MarketRejected[];
  error: string | null;
}

beforeEach(() => {
  githubProxy.prefix = "";
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
  // The first source, as the tests that read one catalog want it; `raw` is the market itself.
  let current = url;
  const flat = async (): Promise<Flat> => {
    const first = (await instance.catalog()).sources[0];
    if (first === undefined)
      return { url: "", entries: null, rejected: [], error: "no source" };
    current = first.source.url;
    return {
      url: first.source.url,
      entries: first.entries,
      rejected: first.rejected,
      error: first.error,
    };
  };
  const adapted = {
    catalog: flat,
    /** Make `address` the only source, and read it. */
    async setUrl(address: string): Promise<Flat> {
      for (const source of instance.sources())
        instance.removeSource(source.url);
      instance.addSource(address, "");
      return await flat();
    },
    async preview(name: string) {
      return await instance.preview(name, current);
    },
    async install(name: string, sha: string) {
      return await instance.install(name, current, sha);
    },
  };
  return { market: adapted, raw: instance, settings, registry, url };
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
  it("starts with Cursor's and Anthropic's lists, and says so when there is none", async () => {
    expect(DEFAULT_SOURCES.map((x) => [x.name, x.enabled])).toEqual([
      ["Anthropic", true],
      ["Cursor", true],
    ]);
    expect(DEFAULT_SOURCES[1]!.url).toBe(
      "https://raw.githubusercontent.com/cursor/plugins/HEAD/.cursor-plugin/marketplace.json",
    );
    expect(DEFAULT_SOURCES[0]!.url).toBe(
      "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json",
    );
    const m = await market();
    expect(m.raw.settings()).toEqual({ sources: DEFAULT_SOURCES, proxy: "" });
    m.settings.set(SOURCES_KEY, []);
    expect(await m.raw.catalog()).toEqual({ sources: [], proxy: "" });
    handler = () => json({ plugins: [item()] });
    const set = await m.market.setUrl(m.url);
    expect(set).toMatchObject({ url: m.url, error: null });
    expect(set.entries?.map((e) => e.name)).toEqual([NAME]);
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
            source: {
              source: "url",
              url: "https://example.com/u.git",
              sha: SHA,
            },
          },
          item({ name: "by-subdir" }),
          {
            name: "by-url-no-sha",
            description: "d",
            source: {
              source: "url",
              url: "https://example.com/u.git",
              ref: "v1",
            },
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
          {
            name: "cmd",
            description: "d",
            source: { source: "command", command: "x" },
          },
          {
            name: "pkg",
            description: "d",
            source: { source: "npm", package: "@acme/x" },
          },
          { name: "nosource", description: "d" },
        ],
      });
    const m = await market();
    const c = await m.market.setUrl(m.url);
    expect(c.entries?.map((e) => e.name)).toEqual([
      NAME,
      "cmd",
      "pkg",
      "nosource",
    ]);
    const cmd = c.entries!.find((e) => e.name === "cmd")!;
    expect(cmd.unsupported).toMatch(/format not supported: source "command"/);
    const pkg = c.entries!.find((e) => e.name === "pkg")!;
    expect(pkg.unsupported).toMatch(/format not supported: source "npm"/);
    expect(c.entries![0]!.unsupported).toBeNull();
    await expect(m.market.preview("cmd")).rejects.toThrow(
      /format not supported/,
    );
    await expect(m.market.install("cmd", SHA)).rejects.toThrow(
      /format not supported/,
    );
  });

  it("supports Claude Code github entries with optional ref, sha and path, and rejects bad repo slugs", async () => {
    handler = () =>
      json({
        plugins: [
          {
            name: "gh-basic",
            description: "d",
            source: { source: "github", repo: "acme/plugin-one" },
          },
          {
            name: "gh-full",
            description: "d",
            source: {
              source: "github",
              repo: "acme/plugin-two.git",
              ref: "v2",
              sha: SHA,
              path: "packages/my-plugin",
            },
          },
          {
            name: "gh-bad-slash",
            description: "d",
            source: { source: "github", repo: "just-one-part" },
          },
          {
            name: "gh-bad-dots",
            description: "d",
            source: { source: "github", repo: "acme/../evil" },
          },
          {
            name: "gh-bad-dash",
            description: "d",
            source: { source: "github", repo: "-evil/repo" },
          },
        ],
      });
    const m = await market();
    const c = await m.market.setUrl(m.url);
    expect(c.entries?.map((e) => e.name)).toEqual(["gh-basic", "gh-full"]);
    expect(c.entries![0]).toMatchObject({
      repo: "https://github.com/acme/plugin-one.git",
      path: "",
      rev: null,
      unsupported: null,
    });
    expect(c.entries![1]).toMatchObject({
      repo: "https://github.com/acme/plugin-two.git",
      path: "packages/my-plugin",
      rev: SHA,
      unsupported: null,
    });
    expect(c.rejected.map((r) => r.name)).toEqual([
      "gh-bad-slash",
      "gh-bad-dots",
      "gh-bad-dash",
    ]);
  });

  it("accepts large catalogs up to 2000 entries and refuses over 2000", async () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        item({ name: `plugin-${i}`, description: "d" }),
      );
    handler = () => json({ plugins: many(600) });
    const m = await market();
    const ok = await m.market.setUrl(m.url);
    expect(ok.error).toBeNull();
    expect(ok.entries).toHaveLength(600);

    handler = () => json({ plugins: many(2001) });
    const tooMany = await m.market.catalog();
    expect(tooMany.entries).toBeNull();
    expect(tooMany.error).toMatch(/more than 2000/);
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

  async function failure(over: Parameters<typeof market>[0]): Promise<Flat> {
    const m = await market(over);
    return await m.market.setUrl(m.url);
  }

  it("refuses a catalog that is too big", async () => {
    handler = () => json({ plugins: [item({ description: "x".repeat(400) })] });
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
      json({
        plugins: [item({ name: "hello-catalog", ...sourceOf({ url, sha }) })],
      });
    const m = await market();
    await m.market.setUrl(m.url);

    const preview = await m.market.preview("hello-catalog");
    expect(preview).toMatchObject({
      name: "hello-catalog",
      manifestName: NAME,
      repo: url,
      path: "sub",
      sha,
    });
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
    expect(m.registry.get(NAME)!.source).toMatchObject({
      sha,
      rev: "HEAD",
      path: "sub",
    });
  });

  it("pins the previewed commit on install while storing the tracking ref so Update advances", async () => {
    const { url, sha: sha1 } = await repo();
    const repoDir = fileURLToPath(url);
    handler = () =>
      json({
        plugins: [
          {
            name: "hello-track",
            description: "d",
            source: { source: "git-subdir", url, path: "sub", ref: "main" },
          },
        ],
      });
    const m = await market();
    await m.market.setUrl(m.url);
    const preview = await m.market.preview("hello-track");
    expect(preview.sha).toBe(sha1);

    // Push a second commit to `main` AFTER preview, BEFORE install.
    await writeFile(join(repoDir, "sub", "CHANGELOG.md"), "v2\n");
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-qm", "second");
    const sha2 = await git(repoDir, "rev-parse", "HEAD");
    expect(sha2).not.toBe(sha1);

    // Install still strictly pins sha1, while recording `rev: "main"`.
    expect(await m.market.install("hello-track", sha1)).toBe(NAME);
    expect(m.registry.get(NAME)!.source).toMatchObject({
      kind: "git",
      repo: url,
      path: "sub",
      rev: "main",
      sha: sha1,
    });

    // Update resolves `main` anew and advances to sha2.
    await m.registry.update(NAME);
    expect(m.registry.get(NAME)!.source).toMatchObject({
      kind: "git",
      repo: url,
      path: "sub",
      rev: "main",
      sha: sha2,
    });
  });

  it("resolves refs/heads/<branch> and refs/tags/<tag> raw.githubusercontent.com catalog URLs", async () => {
    const { url: localRepo, sha: sha1 } = await repo();
    const repoDir = fileURLToPath(localRepo);
    await git(repoDir, "checkout", "-qb", "release");
    await writeFile(join(repoDir, "sub", "RELEASE.txt"), "release branch\n");
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-qm", "release");
    const releaseSha = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "tag", "v1.0.0", sha1);

    const headsUrl =
      "https://raw.githubusercontent.com/o/n/refs/heads/release/.claude-plugin/marketplace.json";
    const tagsUrl =
      "https://raw.githubusercontent.com/o/n/refs/tags/v1.0.0/.claude-plugin/marketplace.json";
    handler = () =>
      json({
        plugins: [{ name: "hello-rel", description: "d", source: "./sub" }],
      });

    const m = await market({ catalogRepo: localRepo });
    m.raw.setProxy(`http://127.0.0.1:${server.port}/px/`);
    for (const source of m.raw.sources()) m.raw.removeSource(source.url);
    m.raw.addSource(headsUrl, "Heads");
    m.raw.addSource(tagsUrl, "Tags");

    const previewHeads = await m.raw.preview("hello-rel", headsUrl);
    expect(previewHeads.sha).toBe(releaseSha);
    const previewTags = await m.raw.preview("hello-rel", tagsUrl);
    expect(previewTags.sha).toBe(sha1);

    await m.raw.install("hello-rel", headsUrl, releaseSha);
    expect(m.registry.get(NAME)!.source).toMatchObject({
      rev: "release",
      sha: releaseSha,
    });
  });

  it("previews a Cursor-layout plugin: skills load, what is ignored is listed", async () => {
    const { url, sha } = await repo();
    handler = () =>
      json({
        plugins: [
          {
            name: "cursor-demo",
            description: "d",
            source: { source: "git-subdir", url, path: "cursor", sha },
          },
        ],
      });
    const m = await market();
    await m.market.setUrl(m.url);
    const preview = await m.market.preview("cursor-demo");
    expect(preview.skills.map((s) => s.name)).toEqual(["a"]);
    expect(preview.servers).toEqual([]);
    const reports = preview.reports.join("\n");
    expect(reports).not.toContain("manifest read from");
    expect(preview.layout).toBe(".cursor-plugin/plugin.json");
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
    await expect(m.market.install(NAME, sha)).rejects.toThrow(
      /look at it again/,
    );
    expect(m.registry.get(NAME)).toBeUndefined();
    await expect(m.market.install(NAME, "main")).rejects.toThrow(/commit hash/);
  });

  it("does not preview a plugin that is not in the catalog", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [item({ ...sourceOf({ url, sha }) })] });
    const m = await market();
    await m.market.setUrl(m.url);
    await expect(m.market.preview("missing")).rejects.toThrow(
      /not in the catalog/,
    );
  });
});

describe("the sources", () => {
  it("adds, removes, refuses a duplicate and an address that is not http(s), and may be empty", async () => {
    const m = await market();
    const custom = "https://example.com/m.json";
    const added = m.raw.addSource(`  ${custom}  `, "  Mine  ");
    expect(added.sources.at(-1)).toEqual({
      url: custom,
      name: "Mine",
      enabled: true,
    });
    expect(added.sources).toHaveLength(3);
    expect(() => m.raw.addSource(custom, "again")).toThrow(
      /in the list already/,
    );
    expect(() => m.raw.addSource(DEFAULT_SOURCES[0]!.url, "")).toThrow(
      /in the list already/,
    );
    expect(() => m.raw.addSource("file:///etc/passwd", "")).toThrow(
      /http\(s\)/,
    );
    expect(() => m.raw.addSource("nope", "")).toThrow(/not a URL/);
    expect(() => m.raw.addSource("", "")).toThrow();
    expect(m.raw.sources()).toHaveLength(3);
    expect(() => m.raw.removeSource("https://example.com/other.json")).toThrow(
      /not in the list/,
    );
    for (const source of m.raw.sources()) m.raw.removeSource(source.url);
    // An emptied list stays empty: it is not seeded again.
    expect(m.raw.settings().sources).toEqual([]);
    expect(m.settings.get(SOURCES_KEY)).toEqual([]);
  });

  it("moves an address kept by an earlier version into the list, once", async () => {
    const custom = "https://example.com/old.json";
    const m = await market();
    m.settings.set(LEGACY_URL_KEY, custom);
    expect(m.raw.sources()).toEqual([
      ...DEFAULT_SOURCES,
      { name: "", url: custom, enabled: true },
    ]);
    expect(m.settings.get(LEGACY_URL_KEY)).toBeUndefined();
    expect(m.settings.get(SOURCES_KEY)).toHaveLength(3);

    const same = await market();
    same.settings.set(LEGACY_URL_KEY, DEFAULT_SOURCES[0]!.url);
    expect(same.raw.sources()).toEqual(DEFAULT_SOURCES);

    // Cursor's address was the user's choice: it stays on, and is not listed twice.
    const cursor = await market();
    cursor.settings.set(LEGACY_URL_KEY, DEFAULT_SOURCES[1]!.url);
    expect(cursor.raw.sources()).toEqual([
      DEFAULT_SOURCES[0],
      { ...DEFAULT_SOURCES[1]!, enabled: true },
    ]);
    expect(
      cursor.raw.sources().filter((x) => x.url === DEFAULT_SOURCES[1]!.url),
    ).toHaveLength(1);

    const none = await market();
    none.settings.set(LEGACY_URL_KEY, "");
    expect(none.raw.sources()).toEqual([]);
    // A stored list is never overwritten by the old key.
    none.settings.set(LEGACY_URL_KEY, custom);
    expect(none.raw.sources()).toEqual([]);
  });

  it("lists every source, shows which each entry came from, and a failing source hides no other", async () => {
    handler = (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/a.json")
        return json({
          plugins: [item({ name: "both" }), item({ name: "only-a" })],
        });
      if (path === "/c.json")
        return json({ plugins: [item({ name: "both" })] });
      if (path === "/slow.json") return new Response("{nope");
      return new Response("gone", { status: 404 });
    };
    const m = await market();
    for (const source of m.raw.sources()) m.raw.removeSource(source.url);
    const base = `http://127.0.0.1:${server.port}`;
    m.raw.addSource(`${base}/a.json`, "A");
    m.raw.addSource(`${base}/b.json`, "");
    m.raw.addSource(`${base}/slow.json`, "Broken");
    m.raw.addSource(`${base}/c.json`, "C");
    const catalog = await m.raw.catalog();
    expect(catalog.sources.map((x) => x.source.url.slice(base.length))).toEqual(
      ["/a.json", "/b.json", "/slow.json", "/c.json"],
    );
    expect(catalog.sources[1]!).toMatchObject({ entries: null });
    expect(catalog.sources[1]!.error).toMatch(/HTTP 404/);
    expect(catalog.sources[2]!.error).toMatch(/not valid JSON/);
    const a = catalog.sources[0]!.entries!;
    const c = catalog.sources[3]!.entries!;
    expect(a.map((e) => e.name)).toEqual(["both", "only-a"]);
    // The same name in two sources: both stay, told apart by their source.
    expect(c[0]).toMatchObject({
      name: "both",
      source: `${base}/c.json`,
      sourceName: "C",
    });
    expect(a[0]).toMatchObject({ source: `${base}/a.json`, sourceName: "A" });
    expect(a[0]!.name).toBe(c[0]!.name);
    // A source with no name is shown by its address.
    expect(catalog.sources[1]!.source.name).toBe("");
    // Preview reads only the source it is asked about.
    await expect(m.raw.preview("only-a", `${base}/c.json`)).rejects.toThrow(
      /not in the catalog/,
    );
    await expect(
      m.raw.preview("both", "https://elsewhere.test/x.json"),
    ).rejects.toThrow(/not one of the plugin sources/);
  });
});

describe("the GitHub proxy", () => {
  const RAW =
    "https://raw.githubusercontent.com/o/n/main/.claude-plugin/marketplace.json";

  it("is off until a prefix is set, and then every URL is as it was", () => {
    expect(githubProxy.prefix).toBe("");
    for (const url of [
      RAW,
      "https://github.com/o/r.git",
      "git@github.com:o/r.git",
      "https://example.com/r.git",
      "file:///tmp/r",
      "not a url",
    ])
      expect(viaProxy(url)).toBe(url);
  });

  it("takes a prefix as typed: http(s) only, one trailing slash, empty is off", () => {
    expect(normalizeProxy("")).toBe("");
    expect(normalizeProxy("   ")).toBe("");
    expect(normalizeProxy("https://p.test")).toBe("https://p.test/");
    expect(normalizeProxy(" https://p.test/a/// ")).toBe("https://p.test/a/");
    expect(normalizeProxy("http://p.test/x/")).toBe("http://p.test/x/");
    expect(() => normalizeProxy("ftp://p.test/")).toThrow(/http\(s\)/);
    expect(() => normalizeProxy("p.test")).toThrow(/not a URL/);
  });

  it("puts the prefix before the whole URL of github.com and raw.githubusercontent.com only", () => {
    const p = "https://p.test/";
    expect(viaProxy(RAW, p)).toBe(`https://p.test/${RAW}`);
    expect(viaProxy("https://github.com/o/r.git", p)).toBe(
      "https://p.test/https://github.com/o/r.git",
    );
    expect(viaProxy("https://GitHub.com/o/r.git", p)).toBe(
      "https://p.test/https://GitHub.com/o/r.git",
    );
    expect(viaProxy(`https://p.test/${RAW}`, p)).toBe(`https://p.test/${RAW}`);
    for (const other of [
      "https://gitlab.com/o/r.git",
      "https://github.com.evil.test/o/r.git",
      "https://example.com/github.com/r.git",
      "git@github.com:o/r.git",
      "file:///tmp/r",
    ])
      expect(viaProxy(other, p)).toBe(other);
  });

  it("joins with exactly one slash however the prefix was typed", () => {
    const repo = "https://github.com/o/r.git";
    for (const typed of [
      "https://gh-proxy.com",
      "https://gh-proxy.com/",
      "  https://gh-proxy.com  ",
      "https://gh-proxy.com//",
    ]) {
      expect(viaProxy(repo, typed)).toBe(`https://gh-proxy.com/${repo}`);
      expect(viaProxy(RAW, typed)).toBe(`https://gh-proxy.com/${RAW}`);
    }
    expect(viaProxy(repo, "  ")).toBe(repo);
    expect(viaProxy(repo, "ftp://gh-proxy.com")).toBe(repo);
  });

  it("is kept as a setting, applied at once, and the catalog is fetched through it", async () => {
    const seen: string[] = [];
    handler = (request) => {
      seen.push(new URL(request.url).pathname);
      return json({
        plugins: [{ name: "rel", description: "d", source: "./plugins/rel" }],
      });
    };
    const m = await market();
    for (const source of m.raw.sources()) m.raw.removeSource(source.url);
    m.raw.addSource(RAW, "Raw");
    m.raw.addSource(`http://127.0.0.1:${server.port}/own.json`, "Own");
    expect(m.raw.setProxy(` http://127.0.0.1:${server.port}/px `).proxy).toBe(
      `http://127.0.0.1:${server.port}/px/`,
    );
    expect(m.settings.get(PROXY_KEY)).toBe(
      `http://127.0.0.1:${server.port}/px/`,
    );
    expect(githubProxy.prefix).toBe(`http://127.0.0.1:${server.port}/px/`);
    const catalog = await m.raw.catalog();
    // The GitHub catalog went through the proxy; the other host's did not.
    expect(seen).toEqual([`/px/${RAW}`, "/own.json"]);
    // A relative path is resolved against the original address, then the repository is fetched through the proxy.
    expect(catalog.sources[0]!.entries![0]).toMatchObject({
      repo: "https://github.com/o/n.git",
      path: "plugins/rel",
    });
    expect(catalog.sources[1]!.entries![0]!.unsupported).toMatch(
      /format not supported/,
    );
    expect(catalog.proxy).toBe(`http://127.0.0.1:${server.port}/px/`);
    expect(() => m.raw.setProxy("ftp://x/")).toThrow();
    expect(m.raw.setProxy("").proxy).toBe("");
    expect(m.settings.get(PROXY_KEY)).toBeUndefined();
    expect(githubProxy.prefix).toBe("");
  });

  it("shows no proxy in the preview of a repository that is not on GitHub", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [item({ ...sourceOf({ url, sha }) })] });
    const m = await market();
    m.raw.setProxy("https://p.test/");
    await m.market.setUrl(m.url);
    expect((await m.market.preview(NAME)).proxy).toBeNull();
  });
});

describe("switching a source on and off", () => {
  /** Every address the market fetched, answering each with one plugin named after its host path. */
  function recordFetches(): { urls: string[]; restore: () => void } {
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return json({
        plugins: [
          {
            name: url.includes("cursor") ? "from-cursor" : "from-anthropic",
            description: "d",
            source: "./p",
          },
        ],
      });
    }) as typeof fetch;
    return { urls, restore: () => void (globalThis.fetch = real) };
  }

  it("on a fresh install reads both lists; switching Cursor off takes its entries away, on brings them back", async () => {
    const seen = recordFetches();
    try {
      const m = await market();
      let catalog = await m.raw.catalog();
      expect(seen.urls.sort()).toEqual(
        DEFAULT_SOURCES.map((x) => x.url).sort(),
      );
      expect(
        catalog.sources.flatMap((x) => x.entries!.map((e) => e.name)).sort(),
      ).toEqual(["from-anthropic", "from-cursor"]);

      m.raw.setSourceEnabled(DEFAULT_SOURCES[1]!.url, false);
      seen.urls.length = 0;
      catalog = await m.raw.catalog();
      expect(seen.urls).toEqual([DEFAULT_SOURCES[0]!.url]);
      expect(catalog.sources.map((x) => x.source.name)).toEqual(["Anthropic"]);
      // Off is not removed: the address and the name stay.
      expect(m.raw.sources()).toEqual([
        DEFAULT_SOURCES[0],
        { ...DEFAULT_SOURCES[1]!, enabled: false },
      ]);

      m.raw.setSourceEnabled(DEFAULT_SOURCES[1]!.url, true);
      seen.urls.length = 0;
      catalog = await m.raw.catalog();
      expect(seen.urls.sort()).toEqual(
        DEFAULT_SOURCES.map((x) => x.url).sort(),
      );
      expect(catalog.sources).toHaveLength(2);
      expect(() =>
        m.raw.setSourceEnabled("https://nope.test/x.json", true),
      ).toThrow(/not in the list/);
    } finally {
      seen.restore();
    }
  });

  it("does not fetch a source that is off, shows no error for it, and cannot preview from it", async () => {
    const seen = recordFetches();
    try {
      const m = await market();
      // Both defaults are on, so both are switched off to leave nothing to read.
      m.raw.setSourceEnabled(DEFAULT_SOURCES[0]!.url, false);
      m.raw.setSourceEnabled(DEFAULT_SOURCES[1]!.url, false);
      seen.urls.length = 0;
      expect(await m.raw.catalog()).toEqual({ sources: [], proxy: "" });
      expect(seen.urls).toEqual([]);
      await expect(
        m.raw.preview("from-anthropic", DEFAULT_SOURCES[0]!.url),
      ).rejects.toThrow(/not one of the plugin sources/);
      expect(seen.urls).toEqual([]);
    } finally {
      seen.restore();
    }
  });

  it("counts a source stored without the flag as on", async () => {
    const m = await market();
    m.settings.set(SOURCES_KEY, [
      { url: "https://old.test/a.json", name: "Old" },
      { url: "https://off.test/b.json", name: "Off", enabled: false },
    ]);
    expect(m.raw.sources()).toEqual([
      { url: "https://old.test/a.json", name: "Old", enabled: true },
      { url: "https://off.test/b.json", name: "Off", enabled: false },
    ]);
  });

  it("keeps an installed plugin installed when its source is switched off", async () => {
    const { url, sha } = await repo();
    handler = () => json({ plugins: [item({ ...sourceOf({ url, sha }) })] });
    const m = await market();
    await m.market.setUrl(m.url);
    await m.market.install(NAME, sha);
    m.raw.setSourceEnabled(m.url, false);
    expect(m.registry.get(NAME)).toBeDefined();
    m.raw.setSourceEnabled(m.url, true);
    expect((await m.market.catalog()).entries![0]!.installed).toBe("this");
  });
});
