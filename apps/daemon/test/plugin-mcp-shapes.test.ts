/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * One resolution, two shapes: what an external runtime is given stays exactly what it was before
 * eta's own loop took plugin servers too, and what eta's loop gets keeps its working directory,
 * takes sse and signs in with OAuth unless the extension sends `Authorization`. Two servers that
 * would share a name do not: the later is left out and reported.
 */
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimServerNames,
  loadPlugin,
  resolvePluginServers,
  runtimeExtras,
  serversConfig,
  toMcpEntries,
  toSessionServers,
} from "../src";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "eta-shapes-")));
  dirs.push(dir);
  return dir;
}

async function plugin(name: string, servers: unknown, extension: unknown = {}) {
  const root = await temp();
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      extensions: { "tech.0xfe.eta": extension },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: servers,
    }),
  );
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "work"));
  return await loadPlugin(root);
}

/** Every kind of server, every field the resolution fills in. */
async function everything() {
  return await plugin(
    "demo.plugin",
    {
      local: {
        type: "stdio",
        command: "./bin/server",
        args: ["--root", "${PLUGIN_ROOT}", "--data=${PLUGIN_DATA}/x"],
        env: { FROM_FILE: "${PLUGIN_DATA}/f", KEY: "file" },
        cwd: "./work",
      },
      bare: { type: "stdio", command: "node" },
      remote: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { authorization: "public", "X-Tenant": "t" },
      },
      open: { type: "streamable-http", url: "https://open.example.com/mcp" },
      legacy: { type: "sse", url: "https://example.com/sse" },
    },
    {
      config: {
        key: { type: "string", secret: true },
        region: { type: "string", default: "eu" },
      },
      mcp: {
        local: { env: { KEY: "key", REGION: "region" } },
        remote: { headers: { Authorization: "Bearer {key}" } },
        legacy: { headers: { "X-Region": "{region}" } },
      },
    },
  );
}

describe("what an external runtime is given", () => {
  // Written down from the code before the split (origin/main ea16bd66): every field, in order.
  it("is the same, field for field, as before eta's own loop took plugin servers", async () => {
    const loaded = await everything();
    const dataDir = await temp();
    const warnings: string[] = [];
    const extras = await runtimeExtras(
      [
        {
          plugin: loaded,
          hash: "a".repeat(64),
          config: serversConfig(loaded, { key: "s3cret" }),
        },
      ],
      { dataDir, runtime: "codex", warn: (warning) => warnings.push(warning) },
    );
    const root = loaded.root;
    const data = join(dataDir, "plugins", "data", "demo.plugin");
    expect(extras.mcpServers).toStrictEqual([
      {
        name: "demo_plugin-local",
        command: "/bin/sh",
        args: [
          "-c",
          'cd "$0" && exec "$@"',
          join(root, "work"),
          join(root, "bin", "server"),
          "--root",
          root,
          `--data=${data}/x`,
        ],
        env: {
          FROM_FILE: `${data}/f`,
          KEY: "s3cret",
          REGION: "eu",
          PLUGIN_ROOT: root,
          PLUGIN_DATA: data,
        },
      },
      {
        name: "demo_plugin-bare",
        command: "/bin/sh",
        args: ["-c", 'cd "$0" && exec "$@"', root, "node"],
        env: { PLUGIN_ROOT: root, PLUGIN_DATA: data },
      },
      {
        name: "demo_plugin-remote",
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Tenant": "t", Authorization: "Bearer s3cret" },
      },
      {
        name: "demo_plugin-open",
        type: "http",
        url: "https://open.example.com/mcp",
      },
    ]);
    expect(
      extras.mcpServers?.map((server) => Object.keys(server)),
    ).toStrictEqual([
      ["name", "command", "args", "env"],
      ["name", "command", "args", "env"],
      ["name", "type", "url", "headers"],
      ["name", "type", "url"],
    ]);
    expect(warnings).toEqual([
      "[eta] plugin demo.plugin: server legacy uses sse, which no runtime takes; skipped",
    ]);
  });
});

describe("what eta's own loop is given", () => {
  it("keeps the working directory, adds no sh, takes sse, and signs in where nothing says otherwise", async () => {
    const loaded = await everything();
    const dataDir = await temp();
    const warnings: string[] = [];
    const entries = toMcpEntries(
      resolvePluginServers(
        [{ plugin: loaded, config: serversConfig(loaded, { key: "s3cret" }) }],
        dataDir,
        (warning) => warnings.push(warning),
      ),
    );
    const root = loaded.root;
    const data = join(dataDir, "plugins", "data", "demo.plugin");
    expect(warnings).toEqual([]);
    expect(entries).toStrictEqual({
      "demo_plugin-local": {
        type: "stdio",
        command: join(root, "bin", "server"),
        args: ["--root", root, `--data=${data}/x`],
        env: {
          FROM_FILE: `${data}/f`,
          KEY: "s3cret",
          REGION: "eu",
          PLUGIN_ROOT: root,
          PLUGIN_DATA: data,
        },
        cwd: join(root, "work"),
      },
      "demo_plugin-bare": {
        type: "stdio",
        command: "node",
        args: [],
        env: { PLUGIN_ROOT: root, PLUGIN_DATA: data },
        cwd: root,
      },
      // The extension sends Authorization: no OAuth.
      "demo_plugin-remote": {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { "X-Tenant": "t", Authorization: "Bearer s3cret" },
      },
      // Nothing does: OAuth, which asks for a login only if the server wants one.
      "demo_plugin-open": {
        type: "streamable-http",
        url: "https://open.example.com/mcp",
        auth: "oauth",
      },
      "demo_plugin-legacy": {
        type: "sse",
        url: "https://example.com/sse",
        headers: { "X-Region": "eu" },
        auth: "oauth",
      },
    });
  });

  it("infers OAuth when the Authorization template has no value to fill", async () => {
    const loaded = await plugin(
      "p",
      { remote: { type: "streamable-http", url: "https://example.com/mcp" } },
      {
        config: { key: { type: "string", secret: true } },
        mcp: { remote: { headers: { Authorization: "Bearer {key}" } } },
      },
    );
    const entries = toMcpEntries(
      resolvePluginServers(
        [{ plugin: loaded, config: serversConfig(loaded, {}) }],
        await temp(),
        () => undefined,
      ),
    );
    expect(entries["p-remote"]).toStrictEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
      auth: "oauth",
    });
  });

  it("does not sign in where Authorization is sent, whatever its case", async () => {
    const loaded = await plugin(
      "p",
      { remote: { type: "streamable-http", url: "https://example.com/mcp" } },
      {
        config: { key: { type: "string", secret: true } },
        mcp: { remote: { headers: { AUTHORIZATION: "Token {key}" } } },
      },
    );
    const entries = toMcpEntries(
      resolvePluginServers(
        [{ plugin: loaded, config: serversConfig(loaded, { key: "k" }) }],
        await temp(),
        () => undefined,
      ),
    );
    expect(entries["p-remote"]).not.toHaveProperty("auth");
    expect(entries["p-remote"]?.headers).toEqual({ AUTHORIZATION: "Token k" });
  });
});

describe("the extension's auth", () => {
  const servers = {
    plain: { type: "streamable-http", url: "https://plain.example.com/mcp" },
    keyed: { type: "streamable-http", url: "https://keyed.example.com/mcp" },
    local: { type: "stdio", command: "node" },
  };
  const resolve = async (
    loaded: Awaited<ReturnType<typeof plugin>>,
    values: Record<string, string> = {},
  ) =>
    resolvePluginServers(
      [{ plugin: loaded, config: serversConfig(loaded, values) }],
      await temp(),
      () => undefined,
    );

  it("is what eta's own loop gets when declared, Authorization or not", async () => {
    const loaded = await plugin("p", servers, {
      config: { key: { type: "string", secret: true } },
      mcp: {
        plain: { auth: false },
        keyed: {
          headers: { Authorization: "Bearer {key}" },
          auth: "oauth",
        },
      },
    });
    expect(loaded.reports).toEqual([]);
    const entries = toMcpEntries(await resolve(loaded, { key: "k" }));
    expect(entries["p-plain"]).toStrictEqual({
      type: "streamable-http",
      url: "https://plain.example.com/mcp",
      auth: false,
    });
    expect(entries["p-keyed"]).toStrictEqual({
      type: "streamable-http",
      url: "https://keyed.example.com/mcp",
      headers: { Authorization: "Bearer k" },
      auth: "oauth",
    });
  });

  it("does not change what an external runtime is given", async () => {
    const declared = await plugin("p", servers, {
      mcp: { plain: { auth: false }, keyed: { auth: "oauth" } },
    });
    const bare = await plugin("p", servers);
    const shape = async (loaded: Awaited<ReturnType<typeof plugin>>) =>
      toSessionServers(await resolve(loaded), () => undefined).filter(
        (server) => server.name !== "p-local",
      );
    expect(await shape(declared)).toStrictEqual(await shape(bare));
  });

  it("is ignored and reported on a stdio server", async () => {
    const loaded = await plugin("p", servers, {
      mcp: { local: { auth: false } },
    });
    expect(loaded.reports).toEqual([
      "extension: mcp.local.auth is for remote servers; ignored",
    ]);
    expect(loaded.servers.map((server) => server.name)).toContain("local");
    expect(toMcpEntries(await resolve(loaded))["p-local"]).not.toHaveProperty(
      "auth",
    );
  });

  it("leaves a server with any other value out, and says so", async () => {
    const loaded = await plugin("p", servers, {
      mcp: { plain: { auth: "bearer" } },
    });
    expect(loaded.reports).toEqual([
      'mcp.json: server plain skipped: its auth must be false or "oauth"',
    ]);
    expect(loaded.servers.map((server) => server.name)).not.toContain("plain");
  });
});

describe("two servers that would share a name", () => {
  it("keep the first, leave the later out and say so, in both shapes", async () => {
    // `a-b` + `c` and `a` + `b-c` are both `a-b-c`; with a `.` made `_`, `x-y` + `z.w` and
    // `x` + `y-z_w` are both `x-y-z_w`.
    const ab = await plugin("a-b", {
      c: { type: "stdio", command: "node", args: ["ab"] },
    });
    const a = await plugin("a", {
      "b-c": { type: "stdio", command: "node", args: ["a"] },
      own: { type: "stdio", command: "node" },
    });
    const x = await plugin("x", {
      "y-z_w": {
        type: "streamable-http",
        url: "https://first.example.com/mcp",
      },
    });
    const xy = await plugin("x-y", {
      "z.w": { type: "streamable-http", url: "https://later.example.com/mcp" },
    });
    const ordered = [a, ab, x, xy];
    const warnings: string[] = [];
    const resolved = resolvePluginServers(
      ordered.map((loaded) => ({ plugin: loaded, config: {} })),
      await temp(),
      (warning) => warnings.push(warning),
    );
    expect(
      resolved.map((server) => `${server.plugin}/${server.server}`),
    ).toEqual(["a/b-c", "a/own", "x/y-z_w"]);
    expect(warnings).toEqual([
      "[eta] plugin a-b: mcp.json: server c skipped: its name a-b-c is taken by server b-c of plugin a",
      "[eta] plugin x-y: mcp.json: server z.w skipped: its name x-y-z_w is taken by server y-z_w of plugin x",
    ]);
    expect(Object.keys(toMcpEntries(resolved))).toEqual([
      "a-b-c",
      "a-own",
      "x-y-z_w",
    ]);
    expect(toMcpEntries(resolved)["x-y-z_w"]?.url).toBe(
      "https://first.example.com/mcp",
    );

    const extras = await runtimeExtras(
      ordered.map((loaded) => ({
        plugin: loaded,
        hash: "b".repeat(64),
        config: {},
      })),
      { dataDir: await temp(), runtime: "codex", warn: () => undefined },
    );
    expect(extras.mcpServers?.map((server) => server.name)).toEqual([
      "a-b-c",
      "a-own",
      "x-y-z_w",
    ]);
    expect((extras.mcpServers?.[0] as { args: string[] }).args.at(-1)).toBe(
      "a",
    );
  });

  it("are found inside one plugin too", async () => {
    const loaded = await plugin("p", {
      "s.1": { type: "stdio", command: "node" },
      s_1: { type: "stdio", command: "node" },
    });
    const { clashes } = claimServerNames([loaded]);
    expect(clashes).toEqual([
      {
        plugin: "p",
        server: "s_1",
        name: "p-s_1",
        takenBy: { plugin: "p", server: "s.1" },
      },
    ]);
  });
});

describe("a Cursor-hosted server the user gave a Cursor credential", () => {
  const CURSOR = "https://api.cursor.com/rest-mcp/google-drive/mcp";
  const entryOf = async (
    url: string,
    headers: { name: string; value: string }[],
  ) => {
    const loaded = await plugin("p", {
      remote: { type: "streamable-http", url },
    });
    return toMcpEntries(
      resolvePluginServers(
        [
          {
            plugin: loaded,
            config: serversConfig(
              loaded,
              {},
              headers.map((header) => ({
                server: "remote",
                ...header,
                plainOk: false,
              })),
            ),
          },
        ],
        await temp(),
        () => undefined,
      ),
    )["p-remote"];
  };

  it("still signs in with OAuth: the Cursor credential is one layer, the service's sign-in the other", async () => {
    const entry = await entryOf(CURSOR, [
      { name: "x-cursor-auth", value: "Bearer cursor-credential" },
    ]);
    expect(entry).toStrictEqual({
      type: "streamable-http",
      url: CURSOR,
      headers: { "x-cursor-auth": "Bearer cursor-credential" },
      auth: "oauth",
    });
  });

  it("does not sign in where the user sends Authorization to it", async () => {
    const entry = await entryOf(CURSOR, [
      { name: "Authorization", value: "Bearer mine" },
    ]);
    expect(entry).not.toHaveProperty("auth");
  });

  it("is a refused credential, not a sign-in, for a server that is not Cursor's", async () => {
    for (const url of [
      "https://example.com/mcp",
      "https://cursor.com.evil.test/mcp",
    ]) {
      const entry = await entryOf(url, [
        { name: "x-cursor-auth", value: "Bearer cursor-credential" },
      ]);
      expect(entry).not.toHaveProperty("auth");
    }
  });
});
