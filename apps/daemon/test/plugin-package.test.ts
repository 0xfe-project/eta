/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * The spec's failure boundaries (§4.1, §5.2, §6.2, §7.1, §7.2.2, §8.1, §11.3): what rejects a
 * plugin, what turns one component type off, and what skips one entry and leaves the rest.
 */
import type { LoadedPluginAgent } from "../src/plugin-package";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin, PluginError } from "../src";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const ETA = "tech.0xfe.eta";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eta-plugin-"));
  dirs.push(dir);
  return dir;
}

/** A plugin on disk; a value that is a string goes in as it is, anything else as JSON. */
async function plugin(
  files: Record<string, unknown> = {},
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const root = await temp();
  const all = {
    "plugin.json": { $schema: PLUGIN, name: "demo", ...manifest },
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const file = join(root, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Does ${name} things.\n---\n\nBody.\n`;

const mcp = (servers: unknown) => ({ $schema: MCP, mcpServers: servers });
const stdio = { type: "stdio", command: "node" };

describe("the manifest", () => {
  it("reads a minimal plugin, with nothing to report", async () => {
    const loaded = await loadPlugin(await plugin());
    expect(loaded).toMatchObject({
      manifest: { name: "demo" },
      skills: [],
      servers: [],
      fields: [],
      reports: [],
    });
  });

  it("reports an unknown top-level field, ignores it and keeps loading", async () => {
    const loaded = await loadPlugin(
      await plugin(
        { "skills/a/SKILL.md": skill("a") },
        { hooks: { nope: true } },
      ),
    );
    expect(loaded.reports).toEqual([
      "plugin.json: unknown field hooks was ignored",
    ]);
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
  });

  it("rejects a plugin with no manifest, or JSON that does not parse", async () => {
    const root = await temp();
    await expect(loadPlugin(root)).rejects.toThrow(PluginError);
    await writeFile(join(root, "plugin.json"), "{");
    await expect(loadPlugin(root)).rejects.toThrow(/plugin\.json/);
  });

  it("rejects a $schema it does not recognize, and never fetches one", async () => {
    await expect(
      loadPlugin(
        await plugin(
          {},
          {
            $schema:
              "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
          },
        ),
      ),
    ).rejects.toThrow(/unsupported \$schema/);
    await expect(
      loadPlugin(await plugin({}, { $schema: undefined })),
    ).rejects.toThrow(/\$schema/);
  });

  it.each([
    "My-Plugin",
    "-start",
    "end-",
    "has--double",
    "too..dots",
    "",
    "a".repeat(65),
  ])("rejects the name %j", async (name) => {
    await expect(loadPlugin(await plugin({}, { name }))).rejects.toThrow(
      /invalid name/,
    );
  });

  it("rejects a field of the wrong type, and does not look at components", async () => {
    const files = { "mcp.json": "not json" };
    await expect(
      loadPlugin(await plugin(files, { version: 1 })),
    ).rejects.toThrow(/version must be a string/);
    await expect(
      loadPlugin(await plugin(files, { author: { name: "x", id: 1 } })),
    ).rejects.toThrow(/author/);
    await expect(
      loadPlugin(await plugin(files, { keywords: "x" })),
    ).rejects.toThrow(/keywords/);
  });

  it("does not validate a version as semver or a URL as a URL", async () => {
    const loaded = await loadPlugin(
      await plugin({}, { version: "banana", homepage: "not a url" }),
    );
    expect(loaded.reports).toEqual([]);
  });

  it("rejects a manifest that resolves outside the plugin", async () => {
    const outside = await temp();
    await writeFile(
      join(outside, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN, name: "demo" }),
    );
    const root = await temp();
    await symlink(join(outside, "plugin.json"), join(root, "plugin.json"));
    await expect(loadPlugin(root)).rejects.toThrow(/outside the plugin/);
  });
});

describe("extensions", () => {
  it("reports a non-object field and keeps loading", async () => {
    const loaded = await loadPlugin(
      await plugin({ "skills/a/SKILL.md": skill("a") }, { extensions: [] }),
    );
    expect(loaded.reports[0]).toContain("extensions is not an object");
    expect(loaded.skills).toHaveLength(1);
  });

  it("does not read a namespace that is not eta's", async () => {
    const loaded = await loadPlugin(
      await plugin(
        {},
        {
          extensions: {
            "com.example.client": { config: "garbage" },
            "another.one": 5,
          },
        },
      ),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.configProblems).toEqual([]);
  });

  it("keeps an invalid config from invalidating the components", async () => {
    const loaded = await loadPlugin(
      await plugin(
        { "skills/a/SKILL.md": skill("a") },
        {
          extensions: {
            [ETA]: { config: { key: { type: "string", nope: 1 } } },
          },
        },
      ),
    );
    expect(loaded.configProblems[0]).toContain("unknown key nope");
    expect(loaded.fields).toEqual([]);
    expect(loaded.skills).toHaveLength(1);
  });

  it("skips a server whose binding names a field that does not exist", async () => {
    const loaded = await loadPlugin(
      await plugin(
        {
          "mcp.json": mcp({
            good: stdio,
            bad: stdio,
            worse: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
          }),
        },
        {
          extensions: {
            [ETA]: {
              config: { key: { type: "string" } },
              mcp: {
                good: { env: { KEY: "key" } },
                bad: { env: { KEY: "typo" } },
                worse: { headers: { Authorization: "Bearer {typo}" } },
                absent: { env: { KEY: "key" } },
              },
            },
          },
        },
      ),
    );
    expect(loaded.servers.map((server) => server.name)).toEqual(["good"]);
    expect(loaded.bindings).toEqual({
      good: { env: { KEY: "key" }, headers: {} },
    });
    expect(loaded.reports).toEqual([
      "mcp.json: server bad skipped: env KEY names unknown field typo",
      "mcp.json: server worse skipped: header Authorization names unknown field typo",
      "extension: mcp.absent names no server of mcp.json",
    ]);
  });

  it("does not let the extension set the reserved variables", async () => {
    const loaded = await loadPlugin(
      await plugin(
        { "mcp.json": mcp({ server: stdio }) },
        {
          extensions: {
            [ETA]: {
              config: { key: { type: "string" } },
              mcp: { server: { env: { PLUGIN_ROOT: "key" } } },
            },
          },
        },
      ),
    );
    expect(loaded.servers).toEqual([]);
  });

  it("reads requires, and only ever reports a bad one", async () => {
    const good = await loadPlugin(
      await plugin({}, { extensions: { [ETA]: { requires: ["node", "gh"] } } }),
    );
    expect(good.requires).toEqual(["node", "gh"]);
    const bad = await loadPlugin(
      await plugin({}, { extensions: { [ETA]: { requires: ["rm -rf /"] } } }),
    );
    expect(bad.requires).toEqual([]);
    expect(bad.reports[0]).toContain("requires");
  });
});

describe("skills", () => {
  it("finds immediate children with a SKILL.md and goes no deeper", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "skills/a/SKILL.md": skill("a"),
        "skills/a/references/note.md": "not a skill",
        "skills/nested/deeper/SKILL.md": skill("deeper"),
        "skills/empty/README.md": "no skill here",
      }),
    );
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
  });

  it("skips a skill that breaks the Agent Skills spec and keeps the others", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "skills/a/SKILL.md": skill("a"),
        "skills/b/SKILL.md": skill("not-b"),
        "skills/c/SKILL.md": "no frontmatter",
      }),
    );
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
    expect(loaded.reports.join("\n")).toContain("skills/b");
    expect(loaded.reports.join("\n")).toContain("skills/c");
  });

  it("treats skills that are not a directory as invalid and goes on", async () => {
    const loaded = await loadPlugin(
      await plugin({ skills: "a file", "mcp.json": mcp({ server: stdio }) }),
    );
    expect(loaded.skills).toEqual([]);
    expect(loaded.servers).toHaveLength(1);
    expect(loaded.reports[0]).toContain("skills");
  });

  it("skips a SKILL.md that resolves outside the plugin", async () => {
    const outside = await temp();
    await writeFile(join(outside, "SKILL.md"), skill("out"));
    const root = await plugin({ "skills/a/SKILL.md": skill("a") });
    await mkdir(join(root, "skills", "out"));
    await symlink(
      join(outside, "SKILL.md"),
      join(root, "skills", "out", "SKILL.md"),
    );
    const loaded = await loadPlugin(root);
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
    expect(loaded.reports[0]).toContain("outside the plugin");
  });
});

describe("mcp.json", () => {
  const withSkill = { "skills/a/SKILL.md": skill("a") };

  it.each([
    ["invalid JSON", "{"],
    ["no $schema", { mcpServers: {} }],
    ["an unknown $schema", { $schema: "x", mcpServers: {} }],
    [
      "another version than plugin.json",
      {
        $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
        mcpServers: {},
      },
    ],
    ["another top-level field", { ...mcp({}), extra: true }],
    ["mcpServers that is not an object", { $schema: MCP, mcpServers: [] }],
  ])("turns MCP off and keeps the skills on %s", async (_, content) => {
    const loaded = await loadPlugin(
      await plugin({ ...withSkill, "mcp.json": content }),
    );
    expect(loaded.servers).toEqual([]);
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
    expect(loaded.reports[0]).toContain("MCP is off");
  });

  it("takes an empty mcpServers, and no mcp.json, without a word", async () => {
    const empty = await loadPlugin(await plugin({ "mcp.json": mcp({}) }));
    expect(empty.reports).toEqual([]);
    expect((await loadPlugin(await plugin())).reports).toEqual([]);
  });

  it("is invalid as a directory, and the rest goes on", async () => {
    const root = await plugin(withSkill);
    await mkdir(join(root, "mcp.json"));
    const loaded = await loadPlugin(root);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.reports[0]).toContain("not a file");
  });

  it("is refused when it resolves outside the plugin", async () => {
    const outside = await temp();
    await writeFile(join(outside, "mcp.json"), JSON.stringify(mcp({})));
    const root = await plugin(withSkill);
    await symlink(join(outside, "mcp.json"), join(root, "mcp.json"));
    const loaded = await loadPlugin(root);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.reports[0]).toContain("outside the plugin");
  });

  const skipped = async (server: unknown): Promise<string> => {
    const loaded = await loadPlugin(
      await plugin({ "mcp.json": mcp({ bad: server, good: stdio }) }),
    );
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["good"]);
    return loaded.reports.join("\n");
  };

  it.each([
    ["no type", { command: "x" }, "unknown type"],
    ["an unknown type", { type: "ws", url: "https://x" }, "unknown type"],
    ["an unknown field", { ...stdio, restart: true }, "unknown field restart"],
    [
      "a field of the other variant",
      { ...stdio, url: "https://x" },
      "unknown field url",
    ],
    ["a shell command", { ...stdio, command: "node server.js" }, "bare"],
    ["an absolute command", { ...stdio, command: "/bin/sh" }, "bare"],
    [
      "a command that escapes",
      { ...stdio, command: "./../x" },
      "outside the plugin",
    ],
    [
      "env naming PLUGIN_ROOT",
      { ...stdio, env: { PLUGIN_ROOT: "x" } },
      "PLUGIN_ROOT",
    ],
    [
      "env naming PLUGIN_DATA",
      { ...stdio, env: { PLUGIN_DATA: "x" } },
      "PLUGIN_DATA",
    ],
    ["a cwd of no known form", { ...stdio, cwd: "data" }, "cwd must start"],
    ["a cwd that escapes", { ...stdio, cwd: "./.." }, "outside the plugin"],
    [
      "a rooted cwd that escapes",
      { ...stdio, cwd: "${PLUGIN_ROOT}/../x" },
      "outside the plugin",
    ],
    [
      "a data cwd that escapes",
      { ...stdio, cwd: "${PLUGIN_DATA}/../x" },
      "outside the plugin",
    ],
    ["args that are not strings", { ...stdio, args: [1] }, "args"],
  ])("skips a server with %s", async (_, server, why) => {
    expect(await skipped(server)).toContain(why);
  });

  const remote = (url: string, headers?: unknown) => ({
    type: "streamable-http",
    url,
    ...(headers === undefined ? {} : { headers }),
  });

  it.each([
    ["a relative url", remote("/mcp"), "absolute"],
    [
      "user information",
      remote("https://a:b@example.com/"),
      "user information",
    ],
    ["a fragment", remote("https://example.com/#x"), "fragment"],
    ["plain http off loopback", remote("http://example.com/"), "https"],
    ["ftp", remote("ftp://example.com/"), "http or https"],
    [
      "a header given twice",
      remote("https://example.com/", { A: "1", a: "2" }),
      "headers",
    ],
    [
      "a bad header name",
      remote("https://example.com/", { "A B": "1" }),
      "headers",
    ],
    [
      "a newline in a header",
      remote("https://example.com/", { A: "1\n2" }),
      "headers",
    ],
  ])("skips a remote server with %s", async (_, server, why) => {
    expect(await skipped(server)).toContain(why);
  });

  it("allows plain http on loopback", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "mcp.json": mcp({
          local: remote("http://localhost:1/mcp"),
          v4: remote("http://127.0.0.2:1/mcp"),
          v6: remote("http://[::1]:1/mcp"),
        }),
      }),
    );
    expect(loaded.servers).toHaveLength(3);
  });

  it("does not mistake an env value or an argument for a path", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "mcp.json": mcp({
          server: { ...stdio, args: ["../../etc"], env: { A: "/etc/passwd" } },
        }),
      }),
    );
    expect(loaded.servers).toHaveLength(1);
  });

  it("accepts a command symlinked inside, and refuses one that points outside", async () => {
    const outside = await temp();
    await writeFile(join(outside, "tool"), "#!/bin/sh\n");
    const root = await plugin({
      "bin/real": "#!/bin/sh\n",
      "mcp.json": mcp({
        inside: { type: "stdio", command: "./bin/link" },
        out: { type: "stdio", command: "./bin/out" },
      }),
    });
    await symlink(join(root, "bin", "real"), join(root, "bin", "link"));
    await symlink(join(outside, "tool"), join(root, "bin", "out"));
    const loaded = await loadPlugin(root);
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["inside"]);
    expect(loaded.reports[0]).toContain("outside the plugin");
  });
});

describe("a Cursor or Claude Code layout", () => {
  async function foreign(
    dir: string,
    manifest: Record<string, unknown>,
    files: Record<string, unknown> = {},
  ): Promise<string> {
    const root = await temp();
    const all = { [`${dir}/plugin.json`]: manifest, ...files };
    for (const [path, content] of Object.entries(all)) {
      const file = join(root, path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return root;
  }

  it.each([".cursor-plugin", ".claude-plugin"])(
    "falls back to %s/plugin.json and loads its skills",
    async (dir) => {
      const loaded = await loadPlugin(
        await foreign(
          dir,
          {
            name: "demo",
            displayName: "Demo",
            version: "1.0.0",
            logo: "a.png",
            category: "x",
            tags: ["t"],
            skills: "./skills/",
          },
          { "skills/a/SKILL.md": skill("a") },
        ),
      );
      expect(loaded.manifest).toMatchObject({ name: "demo", version: "1.0.0" });
      expect(loaded.skills.map((entry) => entry.name)).toEqual(["a"]);
      // The layout is information, not a problem: no report, and `layout` says where it was read.
      expect(loaded.reports).toEqual([]);
      expect(loaded.layout).toBe(`${dir}/plugin.json`);
    },
  );

  it("lists what it ignores: unsupported fields, folders and MCP files, while loading agents/", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".cursor-plugin",
        {
          name: "demo",
          hooks: "./hooks.json",
          agents: "./agents/",
          skills: "./skills/",
        },
        {
          "agents/a.md": "x",
          "rules/r.mdc": "x",
          ".mcp.json": { mcpServers: { s: { command: "node" } } },
        },
      ),
    );
    const text = loaded.reports.join("\n");
    expect(text).toContain("hooks is not supported by eta; ignored");
    expect(text).not.toContain("agents is not supported by eta; ignored");
    expect(text).not.toContain("agents/: not supported by eta; ignored");
    expect(text).toContain("rules/: not supported by eta; ignored");
    expect(text).not.toContain("will run after you confirm");
    expect(text).not.toContain("manifest read from");
    expect(loaded.servers.map((entry) => entry.name)).toEqual(["s"]);
    expect(loaded.agents).toEqual([
      {
        id: "a",
        name: "A",
        description: "",
        path: "agents/a.md",
        instructions: "x",
      },
    ]);
  });

  describe("plugin.json mcpServers", () => {
    const servers = { s: { type: "http", url: "https://example.com/mcp" } };
    const names = (loaded: { servers: { name: string }[] }) =>
      loaded.servers.map((entry) => entry.name);

    it("is not a warning, and unknown fields of a foreign manifest are not either", async () => {
      const loaded = await loadPlugin(
        await foreign(
          ".cursor-plugin",
          {
            name: "demo",
            minClientVersions: { x: 1 },
            mcpServers: "./mcp.json",
          },
          { "mcp.json": { mcpServers: servers } },
        ),
      );
      expect(loaded.reports).toEqual([]);
      expect(names(loaded)).toEqual(["s"]);
    });

    it("reads a string path, an array of paths and an inline object", async () => {
      const path = await loadPlugin(
        await foreign(
          ".claude-plugin",
          { name: "demo", mcpServers: "./config/servers.json" },
          { "config/servers.json": { mcpServers: servers } },
        ),
      );
      expect(names(path)).toEqual(["s"]);
      const list = await loadPlugin(
        await foreign(
          ".claude-plugin",
          { name: "demo", mcpServers: ["./a.json", "b.json"] },
          {
            "a.json": { mcpServers: { one: servers.s } },
            "b.json": { mcpServers: { two: servers.s } },
          },
        ),
      );
      expect(names(list)).toEqual(["one", "two"]);
      const inline = await loadPlugin(
        await foreign(".claude-plugin", { name: "demo", mcpServers: servers }),
      );
      expect(names(inline)).toEqual(["s"]);
      expect(inline.reports).toEqual([]);
    });

    it("reads a file named by the manifest once, even when it is also .mcp.json", async () => {
      const loaded = await loadPlugin(
        await foreign(
          ".claude-plugin",
          { name: "demo", mcpServers: "./.mcp.json" },
          { ".mcp.json": { mcpServers: servers } },
        ),
      );
      expect(names(loaded)).toEqual(["s"]);
      expect(loaded.reports).toEqual([]);
    });

    it("reports a missing file, and refuses a path that leaves the plugin", async () => {
      const missing = await loadPlugin(
        await foreign(".claude-plugin", {
          name: "demo",
          mcpServers: "./nope.json",
        }),
      );
      expect(missing.reports.join("\n")).toContain(
        "nope.json: the file does not exist",
      );
      for (const bad of ["../x.json", "/etc/x.json", "a/../../x.json"]) {
        const loaded = await loadPlugin(
          await foreign(".claude-plugin", { name: "demo", mcpServers: bad }),
        );
        expect(loaded.servers).toEqual([]);
        expect(loaded.reports.join("\n")).toContain(
          "must be relative and stay inside the plugin",
        );
      }
    });

    it("does not follow a symlink out of the plugin", async () => {
      const root = await foreign(".claude-plugin", {
        name: "demo",
        mcpServers: "./link.json",
      });
      const outside = await temp();
      await writeFile(
        join(outside, "x.json"),
        JSON.stringify({ mcpServers: servers }),
      );
      await symlink(join(outside, "x.json"), join(root, "link.json"));
      const loaded = await loadPlugin(root);
      expect(loaded.servers).toEqual([]);
      expect(loaded.reports.join("\n")).toContain(
        "resolves outside the plugin",
      );
    });
  });

  it("prefers the root plugin.json, then .cursor-plugin over .claude-plugin", async () => {
    const both = await foreign(
      ".claude-plugin",
      { name: "claude" },
      {
        ".cursor-plugin/plugin.json": { name: "cursor" },
      },
    );
    expect((await loadPlugin(both)).manifest.name).toBe("cursor");
    await writeFile(
      join(both, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN, name: "root" }),
    );
    expect((await loadPlugin(both)).manifest.name).toBe("root");
  });

  it("drops a field that does not fit instead of refusing the plugin, and still refuses a bad name", async () => {
    const loaded = await loadPlugin(
      await foreign(".claude-plugin", {
        name: "demo",
        author: "x",
        version: 3,
      }),
    );
    expect(loaded.manifest).toEqual({ name: "demo" });
    expect(loaded.reports.join("\n")).toContain("author does not fit");
    await expect(
      loadPlugin(await foreign(".claude-plugin", { name: "Bad Name" })),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it("reads Claude's .mcp.json: stdio with the plugin root, http, and ${VAR} as fields", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            mcpServers: {
              local: {
                command: "${CLAUDE_PLUGIN_ROOT}/bin/run",
                args: ["--root", "${CLAUDE_PLUGIN_ROOT}/data"],
                env: { API_KEY: "${MY_API_KEY}", MODE: "fast" },
              },
              remote: {
                type: "http",
                url: "https://example.com/mcp",
                headers: {
                  Authorization: "Bearer ${REMOTE_TOKEN}",
                  "X-Fixed": "1",
                },
              },
            },
          },
          "bin/run": "x",
        },
      ),
    );
    expect(loaded.servers.map((entry) => entry.name)).toEqual([
      "local",
      "remote",
    ]);
    expect(loaded.servers[0]!.config).toEqual({
      type: "stdio",
      command: "./bin/run",
      args: ["--root", "${PLUGIN_ROOT}/data"],
      env: { MODE: "fast" },
    });
    expect(loaded.servers[1]!.config).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: { "X-Fixed": "1" },
    });
    expect(loaded.bindings).toEqual({
      local: { env: { API_KEY: "MY_API_KEY" }, headers: {} },
      remote: { env: {}, headers: { Authorization: "Bearer {REMOTE_TOKEN}" } },
    });
    expect(
      loaded.fields.map((field) => [field.name, field.secret, field.required]),
    ).toEqual([
      ["MY_API_KEY", true, true],
      ["REMOTE_TOKEN", true, true],
    ]);
    expect(loaded.reports.join("\n")).not.toContain("after you confirm");
  });

  it("reads Cursor's root mcp.json, loads mixed env, and skips unsupported auth and url vars", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".cursor-plugin",
        { name: "demo" },
        {
          "mcp.json": {
            mcpServers: {
              plain: {
                type: "http",
                url: "https://example.com/mcp",
                placement: "x",
              },
              oauth: {
                type: "http",
                url: "https://example.com/o",
                auth: { CLIENT_ID: "x" },
              },
              hosted: { type: "http", url: "https://${HOST}/mcp" },
              mixed: { command: "node", env: { A: "a-${B}" } },
            },
          },
        },
      ),
    );
    expect(loaded.servers.map((entry) => entry.name)).toEqual([
      "plain",
      "mixed",
    ]);
    expect(loaded.bindings.mixed).toEqual({
      env: { A: "a-${B}" },
      headers: {},
    });
    expect(loaded.fields).toMatchObject([
      { name: "B", required: true, secret: false },
    ]);
    const text = loaded.reports.join("\n");
    expect(text).toContain(
      "server oauth skipped: unsupported auth configuration",
    );
    expect(text).toContain("server hosted skipped: url holds a variable");
    expect(text).toContain(
      "server plain: placement not supported by eta; ignored",
    );
    expect(text).not.toContain("after you confirm");
  });

  it("supports ${VAR:-default} in foreign env, headers, and args while keeping secrets default-free", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            mcpServers: {
              local: {
                command: "node",
                args: [
                  "--host",
                  "${API_HOST:-https://api.example.com:8443/v1}",
                  "--token=${API_TOKEN:-dev-fallback}",
                  "--opt-secret=${OPT_SECRET:-}",
                  "--opt-plain=${OPT_PLAIN:-}",
                ],
                env: {
                  MODE: "${RUN_MODE:-fast}",
                  ENDPOINT:
                    "https://${API_HOST:-https://api.example.com:8443/v1}/mcp",
                  AUTH: "Bearer ${API_TOKEN:-dev-fallback}",
                },
              },
              remote: {
                type: "http",
                url: "https://example.com/mcp",
                headers: {
                  "X-Region": "${REGION:-us-east}",
                  Authorization: "Bearer ${REMOTE_KEY:-placeholder}",
                  "X-Optional": "Token ${OPTIONAL_KEY:-}",
                },
              },
            },
          },
        },
      ),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.configProblems).toEqual([]);
    expect(loaded.servers.map((s) => s.name)).toEqual(["local", "remote"]);

    const byName = Object.fromEntries(loaded.fields.map((f) => [f.name, f]));
    // Non-secret defaults populate `default` and are optional.
    expect(byName.API_HOST).toMatchObject({
      secret: false,
      required: false,
      default: "https://api.example.com:8443/v1",
    });
    expect(byName.RUN_MODE).toMatchObject({
      secret: false,
      required: false,
      default: "fast",
    });
    expect(byName.OPT_PLAIN).toMatchObject({
      secret: false,
      required: false,
      default: "",
    });
    expect(byName.REGION).toMatchObject({
      secret: false,
      required: false,
      default: "us-east",
    });
    // Secret fields MUST NEVER carry `default` (schema invariant).
    expect(byName.API_TOKEN).toMatchObject({ secret: true, required: true });
    expect(byName.API_TOKEN).not.toHaveProperty("default");
    expect(byName.REMOTE_KEY).toMatchObject({ secret: true, required: true });
    expect(byName.REMOTE_KEY).not.toHaveProperty("default");
    // Empty fallback on a secret makes it optional, still without `default`.
    expect(byName.OPT_SECRET).toMatchObject({ secret: true, required: false });
    expect(byName.OPT_SECRET).not.toHaveProperty("default");
    expect(byName.OPTIONAL_KEY).toMatchObject({
      secret: true,
      required: false,
    });
    expect(byName.OPTIONAL_KEY).not.toHaveProperty("default");

    expect(loaded.bindings.local).toEqual({
      env: {
        MODE: "RUN_MODE",
        ENDPOINT: "https://${API_HOST:-https://api.example.com:8443/v1}/mcp",
        AUTH: "Bearer ${API_TOKEN:-dev-fallback}",
      },
      headers: {},
      args: {
        1: "${API_HOST:-https://api.example.com:8443/v1}",
        2: "--token=${API_TOKEN:-dev-fallback}",
        3: "--opt-secret=${OPT_SECRET:-}",
        4: "--opt-plain=${OPT_PLAIN:-}",
      },
    });
    expect(loaded.bindings.remote).toEqual({
      env: {},
      headers: {
        "X-Region": "{REGION}",
        Authorization: "Bearer {REMOTE_KEY}",
        "X-Optional": "Token {OPTIONAL_KEY}",
      },
    });
  });

  it("rejects malformed shell parameter expansions and reserved env bindings in foreign servers", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            mcpServers: {
              nested: { command: "node", args: ["${A:-${B}}"] },
              alt: { command: "node", env: { X: "${A:+alt}" } },
              empty: { command: "node", env: { X: "${:-def}" } },
              reservedRoot: {
                command: "node",
                env: { PLUGIN_ROOT: "${FOO}" },
              },
              reservedDefault: {
                command: "node",
                args: ["${PLUGIN_ROOT:-/tmp}"],
              },
              headerData: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { "X-Dir": "${PLUGIN_DATA}" },
              },
              good: { command: "node" },
            },
          },
        },
      ),
    );
    expect(loaded.servers.map((s) => s.name)).toEqual(["good"]);
    const text = loaded.reports.join("\n");
    expect(text).toContain("server nested skipped");
    expect(text).toContain("server alt skipped");
    expect(text).toContain("server empty skipped");
    expect(text).toContain("server reservedRoot skipped: env must not contain");
    expect(text).toContain("server reservedDefault skipped");
    expect(text).toContain("server headerData skipped");
  });

  it("accepts flat top-level server maps in file-based .mcp.json while keeping strict entry validation", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            $schema: "https://example.com/ignored-schema.json",
            local: {
              command: "npx",
              args: ["-y", "pkg", "--token", "${MY_TOKEN}"],
            },
            remote: {
              type: "http",
              url: "https://api.example.com/mcp",
            },
            bad: {
              command: "/bin/sh",
            },
          },
        },
      ),
    );
    expect(loaded.servers.map((s) => s.name)).toEqual(["local", "remote"]);
    expect(loaded.fields.map((f) => f.name)).toEqual(["MY_TOKEN"]);
    expect(loaded.reports).toEqual([
      ".mcp.json: server bad skipped: command must be one bare executable name or a ./ path",
    ]);

    const badFlat = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        { ".mcp.json": { foo: "bar" } },
      ),
    );
    expect(badFlat.servers).toEqual([]);
    expect(badFlat.reports[0]).toContain("has no mcpServers object");
  });

  it("maps remote OAuth auth declarations, skips unknown auth modes, and reports/ignores stdio auth", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            mcpServers: {
              oauthObj: {
                type: "http",
                url: "https://oauth.example.com/mcp",
                auth: { type: "oauth", scopes: ["read"] },
              },
              oauthStr: {
                type: "http",
                url: "https://oauth2.example.com/mcp",
                auth: "oauth",
              },
              noAuth: {
                type: "http",
                url: "https://open.example.com/mcp",
                auth: { type: "none" },
              },
              unknownType: {
                type: "http",
                url: "https://bad.example.com/mcp",
                auth: { type: "mtls" },
              },
              stdioWithAuth: {
                command: "node",
                auth: { type: "oauth" },
              },
            },
          },
        },
      ),
    );
    expect(loaded.servers.map((s) => s.name)).toEqual([
      "oauthObj",
      "oauthStr",
      "noAuth",
      "stdioWithAuth",
    ]);
    expect(loaded.bindings.oauthObj).toEqual({
      env: {},
      headers: {},
      auth: "oauth",
    });
    expect(loaded.bindings.oauthStr).toEqual({
      env: {},
      headers: {},
      auth: "oauth",
    });
    expect(loaded.bindings.noAuth).toEqual({
      env: {},
      headers: {},
      auth: false,
    });
    expect(loaded.bindings.stdioWithAuth).toBeUndefined();
    const text = loaded.reports.join("\n");
    expect(text).toContain(
      'server unknownType skipped: unsupported auth type "mtls"',
    );
    expect(text).toContain(
      "server stdioWithAuth: auth is for remote servers; ignored",
    );
  });

  it("merges shared ${VAR} fields across multiple servers without duplicates or clobbering", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo" },
        {
          ".mcp.json": {
            mcpServers: {
              alpha: {
                command: "node",
                env: {
                  KEY: "${SHARED_API_KEY}",
                  REGION: "${REGION:-us-east}",
                  TIER: "${TIER:-free}",
                },
              },
              beta: {
                type: "http",
                url: "https://example.com/mcp",
                headers: {
                  Authorization: "Bearer ${SHARED_API_KEY}",
                  "X-Region": "${REGION}",
                  "X-Tier": "${TIER:-pro}",
                },
              },
            },
          },
        },
      ),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.fields.map((f) => f.name)).toEqual([
      "SHARED_API_KEY",
      "REGION",
      "TIER",
    ]);
    const byName = Object.fromEntries(loaded.fields.map((f) => [f.name, f]));
    expect(byName.SHARED_API_KEY).toMatchObject({
      description: "Used by the MCP servers alpha, beta.",
      required: true,
      secret: true,
    });
    // beta uses `${REGION}` without a default, so REGION becomes required with no default.
    expect(byName.REGION).toMatchObject({
      description: "Used by the MCP servers alpha, beta.",
      required: true,
      secret: false,
    });
    expect(byName.REGION).not.toHaveProperty("default");
    // Both servers give defaults for TIER; first default is kept cleanly.
    expect(byName.TIER).toMatchObject({
      description: "Used by the MCP servers alpha, beta.",
      required: false,
      secret: false,
      default: "free",
    });
  });

  it("deduplicates fields and deep-merges bindings when a foreign plugin also has extensions['tech.0xfe.eta']", async () => {
    const loaded = await loadPlugin(
      await foreign(
        ".claude-plugin",
        {
          name: "demo",
          extensions: {
            [ETA]: {
              config: {
                API_KEY: {
                  type: "string",
                  title: "Custom API Key",
                  description: "From eta extension",
                  required: true,
                  secret: true,
                  pattern: "^sk-",
                },
                EXTRA: { type: "string", default: "yes" },
              },
              mcp: {
                local: {
                  env: { EXTRA_ENV: "EXTRA" },
                },
                remote: {
                  headers: { "X-Extra": "{EXTRA}" },
                  auth: false,
                },
              },
            },
          },
        },
        {
          ".mcp.json": {
            mcpServers: {
              local: {
                command: "node",
                args: ["--key", "${API_KEY}"],
                env: { KEY: "${API_KEY}" },
              },
              remote: {
                type: "http",
                url: "https://example.com/mcp",
                auth: { type: "oauth" },
                headers: {
                  Authorization: "Bearer ${API_KEY}",
                },
              },
            },
          },
        },
      ),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.configProblems).toEqual([]);
    // No duplicate API_KEY; extension definition takes precedence.
    expect(loaded.fields.map((f) => f.name)).toEqual(["API_KEY", "EXTRA"]);
    expect(loaded.fields[0]).toMatchObject({
      name: "API_KEY",
      title: "Custom API Key",
      description: "From eta extension",
      pattern: "^sk-",
      secret: true,
      required: true,
    });
    // Deep-merged bindings preserve foreign env/headers/args alongside extension additions.
    expect(loaded.bindings.local).toEqual({
      env: { KEY: "API_KEY", EXTRA_ENV: "EXTRA" },
      headers: {},
      args: { 1: "${API_KEY}" },
    });
    expect(loaded.bindings.remote).toEqual({
      env: {},
      headers: {
        Authorization: "Bearer {API_KEY}",
        "X-Extra": "{EXTRA}",
      },
      auth: false,
    });

    // Case-insensitive header override and invalid RE2 pattern preservation in foreign + extension.
    const caseAndRe2 = await loadPlugin(
      await foreign(
        ".claude-plugin",
        {
          name: "demo",
          extensions: {
            [ETA]: {
              config: {
                BAD_REGEX: { type: "string", pattern: "(?=a)" },
              },
            },
          },
        },
        {
          ".mcp.json": {
            mcpServers: {
              s: { command: "node", env: { KEY: "${KEY}" } },
            },
          },
        },
      ),
    );
    expect(caseAndRe2.configProblems[0]).toContain("RE2");

    const caseOverride = await loadPlugin(
      await foreign(
        ".claude-plugin",
        {
          name: "demo",
          extensions: {
            [ETA]: {
              config: { CUSTOM_KEY: { type: "string", secret: true } },
              mcp: {
                remote: {
                  headers: { Authorization: "Token {CUSTOM_KEY}" },
                },
              },
            },
          },
        },
        {
          ".mcp.json": {
            mcpServers: {
              remote: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { authorization: "Bearer ${OLD_KEY}" },
              },
            },
          },
        },
      ),
    );
    expect(caseOverride.bindings.remote).toEqual({
      env: {},
      headers: { Authorization: "Token {CUSTOM_KEY}" },
    });
  });

  it("does not warn about a skills list that only names directories under skills/", async () => {
    const files = { "skills/a/SKILL.md": skill("a") };
    const ok = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo", skills: ["./skills/a", "skills/a/"] },
        files,
      ),
    );
    expect(ok.reports.join("\n")).not.toContain("skills is not at skills/");
    const outside = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo", skills: ["./other/a"] },
        files,
      ),
    );
    expect(outside.reports.join("\n")).toContain("skills is not at skills/");
    const missing = await loadPlugin(
      await foreign(
        ".claude-plugin",
        { name: "demo", skills: ["./skills/nope"] },
        files,
      ),
    );
    expect(missing.reports.join("\n")).toContain("skills is not at skills/");
  });
});

describe("skill names that are not legal", () => {
  const load = async (files: Record<string, string>) => {
    const loaded = await loadPlugin(await plugin(files));
    return {
      names: loaded.skills.map((item) => item.name),
      loaded,
      reports: loaded.reports.join("\n"),
    };
  };

  it("formats a space, uppercase, an underscore and edge symbols, and says so", async () => {
    const { names, reports } = await load({
      "skills/a/SKILL.md": skill("My Skill"),
      "skills/b/SKILL.md": skill("Some_Thing"),
      "skills/c/SKILL.md": skill("--edge!!case--"),
    });
    expect(names).toEqual(["my-skill", "some-thing", "edge-case"]);
    expect(reports).toContain('renamed "My Skill" -> "my-skill"');
    expect(reports).toContain('renamed "--edge!!case--" -> "edge-case"');
  });

  it("keeps the readable part of a mixed Chinese name and cuts a long one to 64", async () => {
    const long = "x".repeat(80);
    const { names } = await load({
      "skills/a/SKILL.md": skill("代码 review"),
      "skills/b/SKILL.md": skill(long),
    });
    expect(names).toEqual(["review", "x".repeat(64)]);
  });

  it("skips a name with nothing usable left, with the reason", async () => {
    const { names, reports } = await load({
      "skills/a/SKILL.md": skill("代码审查"),
    });
    expect(names).toEqual([]);
    expect(reports).toContain("skills/a: skipped");
    expect(reports).toContain("no usable characters");
  });

  it("gives a clash a stable -2: a legal name keeps its own, the first directory keeps the base", async () => {
    const { names } = await load({
      "skills/a/SKILL.md": skill("Foo Bar"),
      "skills/b/SKILL.md": skill("foo_bar"),
      "skills/foo-bar/SKILL.md": skill("foo-bar"),
    });
    expect(names).toEqual(["foo-bar-2", "foo-bar-3", "foo-bar"]);
    const again = await load({
      "skills/foo-bar/SKILL.md": skill("foo-bar"),
      "skills/b/SKILL.md": skill("foo_bar"),
      "skills/a/SKILL.md": skill("Foo Bar"),
    });
    expect([...again.names].sort()).toEqual([...names].sort());
  });

  it("shows the original name, and leaves the skill's text as it was", async () => {
    const root = await plugin({ "skills/a/SKILL.md": skill("My Skill") });
    const loaded = await loadPlugin(root);
    expect(loaded.skills[0]).toMatchObject({
      name: "my-skill",
      renamedFrom: "My Skill",
    });
    expect(await fs.readFile(join(root, "skills/a/SKILL.md"), "utf8")).toBe(
      skill("My Skill"),
    );
  });

  it("still skips what is not a naming fault: a legal name in the wrong directory, no description", async () => {
    const { names, reports } = await load({
      "skills/b/SKILL.md": skill("not-b"),
      "skills/c/SKILL.md": "---\nname: Bad Name\n---\n\nBody.\n",
    });
    expect(names).toEqual([]);
    expect(reports).toContain("skills/b: skipped");
    expect(reports).toContain("skills/c: skipped");
  });
});

describe("skill ignore files", () => {
  it("leaves out a skill that an ignore file in its directory ignores", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "skills/a/SKILL.md": skill("a"),
        "skills/b/SKILL.md": skill("b"),
        "skills/b/.ignore": "SKILL.md\n",
      }),
    );
    expect(loaded.skills.map((item) => item.name)).toEqual(["a"]);
    expect(loaded.reports.join("\n")).toContain(
      "skills/b: skipped: ignored by an ignore file",
    );
  });
});

describe("bundled agents", () => {
  it("returns an empty agents array when a plugin has no agents/", async () => {
    const loaded = await loadPlugin(await plugin());
    const agents: LoadedPluginAgent[] = loaded.agents;
    expect(agents).toEqual([]);
    expect(loaded.reports).toEqual([]);
  });

  it("parses YAML frontmatter including quoted values, multiline/folded descriptions, and ignores unknown Claude/Cursor keys", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "agents/code-reviewer.md": [
          "---",
          'name: "Code Reviewer"',
          "description: >",
          "  Reviews pull requests for correctness,",
          "  security, and test coverage.",
          "tools: Read, Grep, Glob",
          "model: sonnet",
          "color: blue",
          "metadata:",
          "  name: Nested Name Ignored",
          "---",
          "",
          "You are a thorough code reviewer.",
          "",
          "Focus on edge cases.",
        ].join("\n"),
        "agents/security_auditor.md": [
          "---",
          "name: 'Security Auditor''s Bot'",
          "description: |-",
          "  Line one.",
          "  Line two.",
          "---",
          "",
          "Audit every input boundary.",
        ].join("\n"),
        "agents/unnamed-helper.md": [
          "---",
          "description: Plain multiline",
          "  continuation value.",
          "---",
          "",
          "Help with daily tasks.",
        ].join("\n"),
      }),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.agents).toEqual([
      {
        id: "code-reviewer",
        name: "Code Reviewer",
        description:
          "Reviews pull requests for correctness, security, and test coverage.",
        path: "agents/code-reviewer.md",
        instructions:
          "You are a thorough code reviewer.\n\nFocus on edge cases.",
      },
      {
        id: "security-auditor",
        name: "Security Auditor's Bot",
        description: "Line one.\nLine two.",
        path: "agents/security_auditor.md",
        instructions: "Audit every input boundary.",
      },
      {
        id: "unnamed-helper",
        name: "Unnamed Helper",
        description: "Plain multiline continuation value.",
        path: "agents/unnamed-helper.md",
        instructions: "Help with daily tasks.",
      },
    ]);
  });

  it("falls back cleanly for plain markdown with and without a # heading", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "agents/architect.md": [
          "# System Architect",
          "",
          "Designs resilient backend systems",
          "with clear boundaries.",
          "",
          "## Principles",
          "- Keep interfaces narrow.",
        ].join("\n"),
        "agents/list-only.md": ["# Quick Checker", "", "- Check types"].join(
          "\n",
        ),
        "agents/release_manager.md": "Prepare release notes and verify tags.\n",
      }),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.agents).toEqual([
      {
        id: "architect",
        name: "System Architect",
        description: "Designs resilient backend systems with clear boundaries.",
        path: "agents/architect.md",
        instructions: [
          "# System Architect",
          "",
          "Designs resilient backend systems",
          "with clear boundaries.",
          "",
          "## Principles",
          "- Keep interfaces narrow.",
        ].join("\n"),
      },
      {
        id: "list-only",
        name: "Quick Checker",
        description: "",
        path: "agents/list-only.md",
        instructions: "# Quick Checker\n\n- Check types",
      },
      {
        id: "release-manager",
        name: "Release Manager",
        description: "",
        path: "agents/release_manager.md",
        instructions: "Prepare release notes and verify tags.",
      },
    ]);
  });

  it("ignores hidden dotfiles and non-markdown files, and supports agents/<dir>/AGENT.md", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "agents/.hidden.md": "Hidden prompt",
        "agents/README.txt": "Not markdown",
        "agents/config.json": "{}",
        "agents/direct.md": "Direct prompt",
        "agents/nested-bot/AGENT.md":
          "---\nname: Nested Bot\ndescription: Lives in a subdir\n---\n\nNested body.",
        "agents/nested-bot/extra.md": "Ignored sibling",
      }),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.agents).toEqual([
      {
        id: "direct",
        name: "Direct",
        description: "",
        path: "agents/direct.md",
        instructions: "Direct prompt",
      },
      {
        id: "nested-bot",
        name: "Nested Bot",
        description: "Lives in a subdir",
        path: "agents/nested-bot/AGENT.md",
        instructions: "Nested body.",
      },
    ]);
  });

  it("skips empty files and frontmatter-only files with a report", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "agents/empty.md": "   \n\t\n",
        "agents/header-only.md": "---\nname: Empty Body\n---\n   \n",
        "agents/valid.md": "Real instructions.",
      }),
    );
    expect(loaded.agents.map((a) => a.id)).toEqual(["valid"]);
    expect(loaded.reports).toEqual([
      "agents/empty.md: empty instructions; skipped",
      "agents/header-only.md: empty instructions; skipped",
    ]);
  });

  it("rejects symlinks resolving outside the plugin and non-directory agents/", async () => {
    const outside = await temp();
    await writeFile(join(outside, "escape.md"), "Secret outside instructions");
    const root = await plugin({
      "agents/good.md": "Safe instructions",
      "skills/a/SKILL.md": skill("a"),
    });
    await symlink(
      join(outside, "escape.md"),
      join(root, "agents", "escape.md"),
    );
    await mkdir(join(root, "agents", "sub"), { recursive: true });
    await symlink(
      join(outside, "escape.md"),
      join(root, "agents", "sub", "AGENT.md"),
    );

    const loaded = await loadPlugin(root);
    expect(loaded.agents.map((a) => a.id)).toEqual(["good"]);
    expect(loaded.reports.join("\n")).toContain(
      "agents/escape.md: resolves outside the plugin; skipped",
    );
    expect(loaded.reports.join("\n")).toContain(
      "agents/sub/AGENT.md: resolves outside the plugin; skipped",
    );

    const fileAgents = await loadPlugin(
      await plugin({
        agents: "not a dir",
        "skills/a/SKILL.md": skill("a"),
        "mcp.json": mcp({ s: stdio }),
      }),
    );
    expect(fileAgents.agents).toEqual([]);
    expect(fileAgents.skills).toHaveLength(1);
    expect(fileAgents.servers).toHaveLength(1);
    expect(fileAgents.reports[0]).toContain("agents: not a directory");
  });

  it("skips files exceeding 256 KiB and caps at 64 agents per plugin", async () => {
    const oversized = await loadPlugin(
      await plugin({
        "agents/big.md": "x".repeat(256 * 1024 + 1),
        "agents/ok.md": "Small prompt.",
      }),
    );
    expect(oversized.agents.map((a) => a.id)).toEqual(["ok"]);
    expect(oversized.reports).toEqual([
      "agents/big.md: exceeds 256 KiB limit; skipped",
    ]);

    const manyFiles: Record<string, string> = {};
    for (let i = 1; i <= 66; i++)
      manyFiles[`agents/bot-${String(i).padStart(2, "0")}.md`] =
        `Prompt for bot ${i}.`;
    const capped = await loadPlugin(await plugin(manyFiles));
    expect(capped.agents).toHaveLength(64);
    expect(capped.agents[0]!.id).toBe("bot-01");
    expect(capped.agents[63]!.id).toBe("bot-64");
    expect(capped.reports).toEqual([
      "agents: limit of 64 agents reached; remaining files skipped",
    ]);
  });

  it("sorts deterministically and deduplicates colliding agent ids with -2, -3", async () => {
    const loaded = await loadPlugin(
      await plugin({
        "agents/foo_bar.md": "Underscore body",
        "agents/foo-bar.md": "Dash body",
        "agents/Foo Bar.md": "Space body",
      }),
    );
    expect(loaded.reports).toEqual([]);
    expect(loaded.agents.map((a) => [a.path, a.id])).toEqual([
      ["agents/Foo Bar.md", "foo-bar"],
      ["agents/foo-bar.md", "foo-bar-2"],
      ["agents/foo_bar.md", "foo-bar-3"],
    ]);
  });

  it("respects foreign manifest.agents paths, deduplicates with agents/, and rejects escaping paths", async () => {
    const root = await temp();
    const files: Record<string, unknown> = {
      ".claude-plugin/plugin.json": {
        name: "claude-agents",
        agents: [
          "./agents/",
          "./agents/a.md",
          "./custom/b.md",
          "./extra-dir",
          "../outside.md",
          "/etc/passwd",
          "./missing.md",
        ],
      },
      "agents/a.md": "---\nname: Alpha\n---\n\nAlpha instructions.",
      "custom/b.md": "# Beta\n\nBeta summary.\n\nBeta details.",
      "extra-dir/gamma.md": "Gamma instructions.",
    };
    for (const [rel, content] of Object.entries(files)) {
      const target = join(root, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(
        target,
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }

    const loaded = await loadPlugin(root);
    expect(loaded.agents).toEqual([
      {
        id: "a",
        name: "Alpha",
        description: "",
        path: "agents/a.md",
        instructions: "Alpha instructions.",
      },
      {
        id: "b",
        name: "Beta",
        description: "Beta summary.",
        path: "custom/b.md",
        instructions: "# Beta\n\nBeta summary.\n\nBeta details.",
      },
      {
        id: "gamma",
        name: "Gamma",
        description: "",
        path: "extra-dir/gamma.md",
        instructions: "Gamma instructions.",
      },
    ]);
    const reportText = loaded.reports.join("\n");
    expect(reportText).toContain(
      "../outside.md: must be relative and stay inside the plugin",
    );
    expect(reportText).toContain(
      "/etc/passwd: must be relative and stay inside the plugin",
    );
    expect(reportText).toContain("./missing.md: does not exist");
  });
});
