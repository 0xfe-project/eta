import type { PlatformEntry, PlatformGroup } from "@eta/harness";
import type { McpTool } from "@eta/mcp";
import type { ActivePlugin } from "../src/plugin-launch";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DTS_CHARS,
  mcpDeclarations,
  pluginPlatformGroup,
} from "../src/plugin-mcp";

const dirs: string[] = [];
const groups: PlatformGroup[] = [];

const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), "eta-plugin-mcp-"));
  dirs.push(made);
  return made;
};

afterEach(async () => {
  await Promise.all(groups.splice(0).map((group) => group.close()));
  for (const made of dirs.splice(0))
    rmSync(made, { recursive: true, force: true });
});

const tool = (name: string, size = 3): McpTool => ({
  name,
  description: `Does ${name}, in some detail.`,
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: Object.fromEntries(
      Array.from({ length: size }, (_, at) => [
        `field_${at}`,
        { type: "string", description: `The ${at}th field of ${name}.` },
      ]),
    ),
  },
});

describe("what esmrun's description says of the servers", () => {
  it("gives the signature of each tool while there is room", () => {
    const text = mcpDeclarations([
      {
        name: "files",
        about: "Reads files.",
        tools: [
          tool("read"),
          {
            name: "odd-name",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    ]);
    expect(text).toContain("/** Does read, in some detail. */");
    expect(text).toContain("read(input: {");
    expect(text).toContain("field_0?: string;");
    expect(text).toContain('"odd-name"(input: Record<string, unknown>)');
    expect(text).toContain("/** Reads files. */");
  });

  it("uses the shape of a tool's output when it declares one", () => {
    const text = mcpDeclarations([
      {
        name: "files",
        about: "",
        tools: [
          {
            ...tool("count"),
            outputSchema: {
              type: "object",
              properties: { n: { type: "number" } },
            },
          },
        ],
      },
    ]);
    expect(text).toContain("n?: number;");
  });

  it("says how to learn the tools of a server that has not run", () => {
    const text = mcpDeclarations([
      { name: "cold", about: "Cold.", tools: undefined },
    ]);
    expect(text).toContain("cold: any;");
    expect(text).toContain("`$tools()` starts it");
  });

  it("falls back to names when signatures do not fit, and stays within the limit", () => {
    const tools = Array.from({ length: 200 }, (_, at) => tool(`tool_${at}`, 8));
    const text = mcpDeclarations([{ name: "big", about: "Big.", tools }]);
    expect(text.length).toBeLessThanOrEqual(DTS_CHARS);
    expect(text).toContain("200 tools");
    expect(text).toContain("tool_0, tool_1");
    expect(text).toContain("and 160 more");
    expect(text).not.toContain("tool_0(input");
  });

  it("does not let one enormous server cost a small one its signatures", () => {
    const big = Array.from({ length: 200 }, (_, at) => tool(`tool_${at}`, 8));
    const text = mcpDeclarations([
      { name: "big", about: "", tools: big },
      { name: "small", about: "", tools: [tool("read")] },
    ]);
    expect(text).toContain("read(input: {");
    expect(text).toContain("tool_0, tool_1");
  });

  it("stays within the limit however many servers there are", () => {
    const servers = Array.from({ length: 300 }, (_, at) => ({
      name: `server_${at}`,
      about: "A server that does a number of things for you.",
      tools: [tool("read", 8), tool("write", 8)],
    }));
    const text = mcpDeclarations(servers);
    expect(text.length).toBeLessThanOrEqual(DTS_CHARS);
    expect(text).toContain("more servers");
    expect(text).toContain("Object.keys(eta.platform.mcp)");
  });

  it("keeps a server's words from closing the comment they are in", () => {
    const text = mcpDeclarations([
      {
        name: "files",
        about: "",
        tools: [{ ...tool("read"), description: "One */ two\nthree" }],
      },
    ]);
    expect(text).toContain("/** One * / two three */");
  });
});

/** The smallest plugin that starts `script` with node, as `sessionServers` would. */
function plugin(
  name: string,
  script: string,
  env: Record<string, string> = {},
): ActivePlugin {
  const root = dir();
  const file = join(root, "server.mjs");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return {
    hash: name.padEnd(64, "0"),
    config: { server: { env } },
    plugin: {
      root,
      manifest: { name, description: `The ${name} plugin.` },
      servers: [
        {
          name: "server",
          config: {
            type: "stdio",
            command: process.execPath,
            args: [file],
            env: { BUN_BE_BUN: "1" },
          },
        },
      ],
      skills: [],
      fields: [],
      bindings: {},
      reports: [],
      configProblems: [],
      requires: [],
    },
  } as unknown as ActivePlugin;
}

const SERVER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result =
    method === "initialize"
      ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } }
      : method === "tools/list"
        ? { tools: [{ name: "show", description: "Show " + process.env.GIVEN, inputSchema: { type: "object" } }, { name: "then", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "given " + process.env.GIVEN + " root " + process.env.PLUGIN_ROOT }] };
  send({ jsonrpc: "2.0", id, result });
});`;

const scrub = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[secret]")) as T;

async function groupOf(
  plugins: ActivePlugin[],
  dataDir = dir(),
): Promise<PlatformGroup> {
  const group = await pluginPlatformGroup(plugins, {
    dataDir,
    sessionDir: dir(),
    clean: scrub,
    warn: () => undefined,
  });
  if (group === undefined) throw new Error("no group");
  groups.push(group);
  return group;
}

const branch = (entry: PlatformEntry | undefined) => {
  if (entry === undefined || typeof entry === "function")
    throw new Error("not a branch");
  return entry;
};

const leaf = (entry: PlatformEntry | undefined) => {
  if (typeof entry !== "function") throw new Error("not a call");
  return entry;
};

describe("the platform group", () => {
  it("is nothing when no plugin has a server", async () => {
    const none = plugin("none", SERVER);
    (none.plugin as { servers: unknown[] }).servers = [];
    expect(
      await pluginPlatformGroup([none], {
        dataDir: dir(),
        sessionDir: dir(),
        clean: scrub,
        warn: () => undefined,
      }),
    ).toBeUndefined();
  });

  it("names servers as a script can write them, unique across plugins", async () => {
    const group = await groupOf([plugin("a-b", SERVER), plugin("a.b", SERVER)]);
    expect(group.root.keys()).toEqual(["a_b_server", "a_b_server_2"]);
  });

  it("calls a tool with no list in hand, on the server of that plugin", async () => {
    const one = plugin("one", SERVER, { GIVEN: "configured" });
    const group = await groupOf([one]);
    const server = branch(group.root.get("one_server"));
    const answer = await leaf(server.get("show"))({});
    expect(answer).toBe(`given configured root ${one.plugin.root}`);
  });

  it("starts a server to read its tools once, and then knows them", async () => {
    const one = plugin("one", SERVER);
    const group = await groupOf([one]);
    expect(group.declarations()).toContain("`$tools()` starts it");
    const server = branch(group.root.get("one_server"));
    const tools = (await leaf(server.get("$tools"))({})) as McpTool[];
    expect(tools.map((t) => t.name)).toEqual(["show", "then"]);
    expect(server.keys()).toEqual(["show", "then", "$tools"]);
    expect(group.declarations()).toContain("show(input:");
  });

  it("reads one tool's details, and says so when there is no such tool", async () => {
    const group = await groupOf([plugin("one", SERVER)]);
    const server = branch(group.root.get("one_server"));
    const list = leaf(server.get("$tools"));
    expect(await list({ tool: "show" })).toMatchObject({ name: "show" });
    await expect(list({ tool: "nope" })).rejects.toThrow(/no tool nope.*show/);
  });

  it("knows a server from an earlier session without starting it", async () => {
    const dataDir = dir();
    const one = plugin("one", SERVER);
    const first = await groupOf([one], dataDir);
    await leaf(branch(first.root.get("one_server")).get("$tools"))({});
    await first.close();
    const crashing = plugin("one", "process.exit(1)");
    const next = await groupOf([crashing], dataDir);
    expect(next.declarations()).toContain("show(input:");
    expect(
      await leaf(branch(next.root.get("one_server")).get("$tools"))({
        tool: "show",
      }),
    ).toMatchObject({ name: "show" });
  });

  it("takes what a session must not see out of what a server says", async () => {
    const dataDir = dir();
    const group = await groupOf(
      [plugin("one", SERVER, { GIVEN: "hunter2" })],
      dataDir,
    );
    const server = branch(group.root.get("one_server"));
    expect(await leaf(server.get("show"))({})).toContain("[secret]");
    expect(group.declarations()).toContain("Show [secret]");
    expect(group.declarations()).not.toContain("hunter2");
  });

  it("does not answer as a thenable, or for what every object has", async () => {
    const group = await groupOf([plugin("one", SERVER)]);
    const server = branch(group.root.get("one_server"));
    expect(server.get("then")).toBeUndefined();
    expect(server.get("toJSON")).toBeUndefined();
    expect(server.get("constructor")).toBeUndefined();
  });

  it("reaches a tool named like one of those once it is known to exist", async () => {
    const group = await groupOf([plugin("one", SERVER)]);
    const server = branch(group.root.get("one_server"));
    await leaf(server.get("$tools"))({});
    expect(typeof server.get("then")).toBe("function");
  });
});
