/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * The spec's failure boundaries (§4.1, §5.2, §6.2, §7.1, §7.2.2, §8.1, §11.3): what rejects a
 * plugin, what turns one component type off, and what skips one entry and leaves the rest.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin, PluginError } from "../src";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const ETA = "moe.akr.eta";

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
