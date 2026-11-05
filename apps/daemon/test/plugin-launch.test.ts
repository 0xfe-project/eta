/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/** From a read plugin to what a runtime is given: §9's expansion, and the configuration going in. */
import type { SessionMcpServer } from "@eta/client-contracts";
import { readdirSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlugin,
  pluginDataDir,
  runtimeExtras,
  serversConfig,
  sessionServerName,
} from "../src";
import { sessionServers } from "../src/plugin-launch";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "eta-launch-")));
  dirs.push(dir);
  return dir;
}

async function plugin(servers: unknown, extension: unknown = {}) {
  const root = await temp();
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "demo.plugin",
      extensions: { "moe.akr.eta": extension },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: servers,
    }),
  );
  return await loadPlugin(root);
}

type Stdio = Extract<SessionMcpServer, { command: string }>;

async function only(
  loaded: Awaited<ReturnType<typeof plugin>>,
  values: Record<string, never> | Record<string, string | number> = {},
): Promise<{ server: SessionMcpServer; data: string }> {
  const dataDir = await temp();
  const warnings: string[] = [];
  const servers = await sessionServers(
    loaded,
    dataDir,
    serversConfig(loaded, values),
    (warning) => warnings.push(warning),
  );
  expect(warnings).toEqual([]);
  return {
    server: servers[0]!,
    data: join(dataDir, "plugins", "data", loaded.manifest.name),
  };
}

const argv = (server: SessionMcpServer) => (server as Stdio).args!.slice(2);

describe("placeholders", () => {
  it("expands args, env and cwd once, and leaves everything else literal", async () => {
    const loaded = await plugin({
      server: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/a", "${PLUGIN_DATA}", "${HOME}", "$PLUGIN_ROOT"],
        env: { A: "${PLUGIN_DATA}/x", B: "${config.key}", ROOT: "${PATH}" },
        cwd: "${PLUGIN_ROOT}",
      },
    });
    const { server, data } = await only(loaded);
    expect(argv(server)).toEqual([
      loaded.root,
      "node",
      `${loaded.root}/a`,
      data,
      "${HOME}",
      "$PLUGIN_ROOT",
    ]);
    expect((server as Stdio).env).toEqual({
      A: `${data}/x`,
      B: "${config.key}",
      ROOT: "${PATH}",
      PLUGIN_ROOT: loaded.root,
      PLUGIN_DATA: data,
    });
  });

  it("does not scan what a replacement brought in", async () => {
    const loaded = await plugin({
      server: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}${PLUGIN_DATA}"],
      },
    });
    const { server, data } = await only(loaded);
    expect(argv(server)[2]).toBe(`${loaded.root}${data}`);
  });
});

describe("a stdio server", () => {
  it("starts in the plugin's directory unless told otherwise", async () => {
    const loaded = await plugin({
      server: { type: "stdio", command: "node" },
    });
    expect(argv((await only(loaded)).server)[0]).toBe(loaded.root);
  });

  it("resolves ./ against the plugin and leaves a bare command to PATH", async () => {
    const loaded = await plugin({
      a: { type: "stdio", command: "./bin/server" },
    });
    expect(argv((await only(loaded)).server)[1]).toBe(
      join(loaded.root, "bin", "server"),
    );
  });

  it("really runs in that directory, with its arguments intact", async () => {
    const loaded = await plugin({
      server: {
        type: "stdio",
        command: "printf",
        args: ["%s|%s|%s", "a b", "$HOME", "'"],
        cwd: "${PLUGIN_DATA}",
      },
    });
    const { server, data } = await only(loaded);
    const { command, args } = server as Stdio;
    const child = Bun.spawn([command, ...args!], { stdout: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("a b|$HOME|'");
    expect(argv(server)[0]).toBe(data);
  });

  it("refuses a data cwd that a symlink takes outside, on this machine", async () => {
    const loaded = await plugin({
      server: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/link" },
    });
    const dataDir = await temp();
    const data = pluginDataDir(dataDir, loaded.manifest.name);
    const { symlink } = await import("node:fs/promises");
    await symlink(await temp(), join(data, "link"));
    const warnings: string[] = [];
    const servers = await sessionServers(loaded, dataDir, {}, (warning) =>
      warnings.push(warning),
    );
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain("cwd of server");
  });
});

describe("configuration", () => {
  const extension = {
    config: {
      key: { type: "string", secret: true },
      count: { type: "number", default: 3 },
      tags: {
        type: "select",
        multiple: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      unset: { type: "string" },
    },
    mcp: {
      server: {
        env: { KEY: "key", COUNT: "count", TAGS: "tags", UNSET: "unset" },
      },
    },
  };

  it("reaches a stdio server as its environment, under the reserved names", async () => {
    const loaded = await plugin(
      { server: { type: "stdio", command: "node", env: { KEY: "from-file" } } },
      extension,
    );
    const { server } = await only(loaded, {
      key: "s3cret",
      tags: ["a", "b"] as never,
    });
    expect((server as Stdio).env).toMatchObject({
      KEY: "s3cret",
      COUNT: "3",
      TAGS: "a,b",
    });
    expect((server as Stdio).env).not.toHaveProperty("UNSET");
  });

  it("reaches a remote server as headers from a template, over the file's", async () => {
    const loaded = await plugin(
      {
        server: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { authorization: "public", "X-Tenant": "t" },
        },
      },
      {
        config: { key: { type: "string", secret: true } },
        mcp: {
          server: {
            headers: { Authorization: "Bearer {key}", "X-Plain": "fixed" },
          },
        },
      },
    );
    const { server } = await only(loaded, { key: "s3cret" });
    expect(server).toEqual({
      name: sessionServerName("demo.plugin", "server"),
      type: "http",
      url: "https://example.com/mcp",
      headers: {
        "X-Tenant": "t",
        Authorization: "Bearer s3cret",
        "X-Plain": "fixed",
      },
    });
  });

  it("leaves out a header whose field has no value", async () => {
    const loaded = await plugin(
      { server: { type: "streamable-http", url: "https://example.com/mcp" } },
      {
        config: { key: { type: "string", secret: true } },
        mcp: { server: { headers: { Authorization: "Bearer {key}" } } },
      },
    );
    expect((await only(loaded)).server).not.toHaveProperty("headers");
  });
});

describe("servers no runtime takes", () => {
  it("leaves sse out and says so", async () => {
    const loaded = await plugin({
      legacy: { type: "sse", url: "https://example.com/sse" },
      modern: { type: "streamable-http", url: "https://example.com/mcp" },
    });
    const warnings: string[] = [];
    const servers = await sessionServers(loaded, await temp(), {}, (warning) =>
      warnings.push(warning),
    );
    expect(servers.map((server) => server.name)).toEqual([
      "demo_plugin-modern",
    ]);
    expect(warnings[0]).toContain("sse");
  });
});

describe("the data directory", () => {
  it("is made, and what it holds stays across a new call", async () => {
    const dataDir = await temp();
    const data = pluginDataDir(dataDir, "demo");
    await mkdir(join(data, "cache"));
    await writeFile(join(data, "cache", "kept"), "x");
    expect(pluginDataDir(dataDir, "demo")).toBe(data);
    expect(await Bun.file(join(data, "cache", "kept")).text()).toBe("x");
  });
});

describe("skills on an external runtime", () => {
  async function skilled() {
    const root = await temp();
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "demo",
      }),
    );
    await mkdir(join(root, "skills", "good"), { recursive: true });
    await writeFile(
      join(root, "skills", "good", "SKILL.md"),
      "---\nname: good\ndescription: Does good things.\n---\n\nBody.\n",
    );
    await mkdir(join(root, "skills", "bad"));
    await writeFile(join(root, "skills", "bad", "SKILL.md"), "no frontmatter");
    // What a Claude plugin may hold: eta supports none of it, so it must not get through.
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "hooks.json"), "{}");
    await mkdir(join(root, "commands"));
    await writeFile(join(root, "commands", "run.md"), "Run.");
    return await loadPlugin(root);
  }

  const extras = async (runtime: string) => {
    const loaded = await skilled();
    const dataDir = await temp();
    return {
      loaded,
      dataDir,
      extras: await runtimeExtras(
        [{ plugin: loaded, hash: "a".repeat(64), config: {} }],
        { dataDir, runtime, warn: () => undefined },
      ),
    };
  };

  it("gives Claude Code a directory of only the valid skills", async () => {
    const { extras: got, loaded } = await extras("claude");
    expect(got.skills).toBeUndefined();
    expect(got.launchArgs?.[0]).toBe("--plugin-dir");
    const dir = got.launchArgs![1]!;
    expect(dir.endsWith("/demo")).toBe(true);
    expect(readdirSync(dir)).toEqual(["skills"]);
    expect(readdirSync(join(dir, "skills"))).toEqual(["good"]);
    expect(await readlink(join(dir, "skills", "good"))).toBe(
      join(loaded.root, "skills", "good"),
    );
    expect(
      await readFile(join(dir, "skills", "good", "SKILL.md"), "utf8"),
    ).toContain("Does good things.");
  });

  it("can be asked again for the same contents", async () => {
    const { extras: first, dataDir, loaded } = await extras("claude");
    const again = await runtimeExtras(
      [{ plugin: loaded, hash: "a".repeat(64), config: {} }],
      { dataDir, runtime: "claude", warn: () => undefined },
    );
    expect(again.launchArgs).toEqual(first.launchArgs);
  });

  it.each(["codex", "opencode", "pi"])(
    "tells %s of them in the prompt",
    async (runtime) => {
      const { extras: got } = await extras(runtime);
      expect(got.launchArgs).toBeUndefined();
      expect(got.skills).toContain("<name>good</name>");
      expect(got.skills).toContain("SKILL.md");
      expect(got.skills).not.toContain("<name>bad</name>");
    },
  );
});
