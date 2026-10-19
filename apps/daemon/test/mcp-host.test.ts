/**
 * MCP on one machine: where a session's servers come from, the tools it is given, and the hooks
 * that tie the library to the session (approval, forms, akhook), against a real stdio server.
 */
import type { AskPayload } from "@eta/core";
import type { AskResponse, OpenSession } from "@eta/harness";
import type { McpConfigSource, McpServerEntry } from "@eta/mcp";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel } from "@eta/core";
import { AskRegistry } from "@eta/harness";
import { AkhookSession } from "@eta/plugin-akhook";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHost, mcpSources } from "../src/mcp-host";

// A child process starting under a loaded machine (the whole repo's tests at once) is slow.
vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(
  new URL("./fixtures/fake-mcp-stdio.ts", import.meta.url),
);
const fake = (extra: Partial<McpServerEntry> = {}): McpServerEntry => ({
  command: process.execPath,
  args: [script],
  ...extra,
});

const roots: string[] = [];
const hosts: McpHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function world(options: { graceMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eta-mcp-host-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(join(home, ".eta"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const warnings: string[] = [];
  const host = new McpHost({
    dataDir: join(root, "state"),
    home,
    warn: (message) => warnings.push(message),
    graceMs: options.graceMs,
    manager: { resolvers: false, checkIntervalMs: 0 },
  });
  hosts.push(host);
  const asked: AskPayload[] = [];
  const answers: ((payload: AskPayload) => AskResponse)[] = [];
  const openSession = (agentId = "ada") => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const ask = new AskRegistry({
      headless: async (payload) => {
        asked.push(payload);
        return answers.shift()?.(payload) ?? { kind: "none" };
      },
    });
    const session = { kernel, ask } as unknown as OpenSession;
    return {
      session,
      meta: { id: `s-${agentId}`, createdAt: 0, cwd, agentId },
    };
  };
  const write = (path: string, servers: Record<string, McpServerEntry>) =>
    writeFile(path, JSON.stringify({ mcpServers: servers }));
  return {
    root,
    home,
    cwd,
    host,
    warnings,
    asked,
    answers,
    openSession,
    writeGlobal: (servers: Record<string, McpServerEntry>) =>
      write(join(home, ".eta", "mcp.json"), servers),
    writeProject: (servers: Record<string, McpServerEntry>) =>
      write(join(cwd, ".mcp.json"), servers),
  };
}

const textOf = (result: unknown): string =>
  (result as { content: { text?: string }[] }).content
    .map((block) => block.text ?? "")
    .join("\n");

/** The tool a session was given, by name. */
const toolOf = (open: { session: OpenSession }, name: string) => {
  const tool = open.session.kernel.tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return (args: unknown) =>
    tool.execute(args, { turn: 0, toolCallId: `call-${Math.random()}` });
};

const bundle = (
  name: string,
  servers: Record<string, McpServerEntry>,
): McpConfigSource => ({ name: `bundle:${name}`, servers });

describe("where a session's servers come from", () => {
  it("merges the bundles, the user's file and the project's, the later winning by name", async () => {
    const w = await world();
    await w.writeGlobal({
      shared: fake({ description: "global" }),
      mine: fake(),
    });
    await w.writeProject({ shared: fake({ description: "project" }) });
    const sources = mcpSources({
      home: w.home,
      cwd: w.cwd,
      bundles: [
        bundle("demo", {
          shared: fake({ description: "bundle" }),
          fromBundle: fake(),
        }),
      ],
      warn: () => undefined,
    });
    expect(sources.map((source) => source.name)).toEqual([
      "bundle:demo",
      "~/.eta/mcp.json",
      ".mcp.json",
    ]);

    const open = w.openSession();
    w.host.sessionTools({
      ...open,
      bundles: [
        bundle("demo", {
          shared: fake({ description: "bundle" }),
          fromBundle: fake(),
        }),
      ],
    });
    const [{ scope }] = w.host.scopes();
    expect(scope.definition("shared")).toMatchObject({
      source: ".mcp.json",
      description: "project",
    });
    expect(scope.definition("mine")?.source).toBe("~/.eta/mcp.json");
    expect(scope.definition("fromBundle")?.source).toBe("bundle:demo");
  });

  it("loads a project's .mcp.json without asking, and says what is wrong with a broken file", async () => {
    const w = await world();
    await writeFile(join(w.cwd, ".mcp.json"), "{ not json");
    expect(
      mcpSources({
        home: w.home,
        cwd: w.cwd,
        bundles: [],
        warn: (message) => w.warnings.push(message),
      }),
    ).toEqual([]);
    expect(w.warnings.join()).toContain(".mcp.json");

    await w.writeProject({ project: fake() });
    const open = w.openSession();
    const tools = w.host.sessionTools({ ...open, bundles: [] });
    expect(tools.map((tool) => tool.name)).toEqual(["mcp"]);
  });

  it("gives a session with no servers no tools at all", async () => {
    const w = await world();
    expect(w.host.sessionTools({ ...w.openSession(), bundles: [] })).toEqual(
      [],
    );
  });
});

describe("the tools of a session", () => {
  it("is the proxy at once, without starting anything, and calls reach the server lazily", async () => {
    const w = await world();
    await w.writeProject({ fake: fake() });
    const open = w.openSession();
    const tools = w.host.sessionTools({ ...open, bundles: [] });
    // Registered by the session manager from the return value.
    for (const tool of tools) open.session.kernel.tools.register(tool);
    expect(w.host.manager.servers.get("ada", "fake")).toBeUndefined();

    const result = await toolOf(
      open,
      "mcp",
    )({
      tool: "echo",
      server: "fake",
      args: { text: "hello" },
    });
    expect(textOf(result)).toContain("hello");
  });

  it("offers a bundle's directTools as session tools, from the cache, once a server has been read", async () => {
    const w = await world();
    const sources = [bundle("demo", { fake: fake({ directTools: ["echo"] }) })];
    const first = w.openSession();
    const before = w.host.sessionTools({ ...first, bundles: sources });
    // Nothing is known about the server yet, so nothing is direct. It is read in the background
    // and the tool turns up in the session when it has been.
    expect(before.map((tool) => tool.name)).toEqual(["mcp"]);
    await until(
      () => first.session.kernel.tools.get("mcp__fake__echo") !== undefined,
    );

    // A later session of the agent (here, another one) has it from the start.
    const second = w.openSession();
    const tools = w.host.sessionTools({ ...second, bundles: sources });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mcp",
      "mcp__fake__echo",
    ]);
    for (const tool of tools) second.session.kernel.tools.register(tool);
    const result = await toolOf(second, "mcp__fake__echo")({ text: "direct" });
    expect(textOf(result)).toContain("direct");
    // Only the tool the config named.
    expect(second.session.kernel.tools.get("mcp__fake__pid")).toBeUndefined();
  });

  it("shares an agent's connections between its sessions, and keeps agents apart", async () => {
    const w = await world();
    await w.writeProject({ fake: fake() });
    const pid = async (agentId: string, id: string) => {
      const open = w.openSession(agentId);
      const tools = w.host.sessionTools({
        ...open,
        meta: { ...open.meta, id },
        bundles: [],
      });
      for (const tool of tools) open.session.kernel.tools.register(tool);
      return textOf(await toolOf(open, "mcp")({ tool: "pid", server: "fake" }));
    };
    const one = await pid("ada", "s1");
    const two = await pid("ada", "s2");
    const other = await pid("bob", "s3");
    expect(two).toBe(one);
    expect(other).not.toBe(one);
  });

  it("closes an agent's connections a while after its last session, not before", async () => {
    const w = await world({ graceMs: 50 });
    await w.writeProject({ fake: fake() });
    const open = w.openSession();
    for (const tool of w.host.sessionTools({ ...open, bundles: [] }))
      open.session.kernel.tools.register(tool);
    await toolOf(open, "mcp")({ tool: "pid", server: "fake" });
    expect(w.host.manager.servers.get("ada", "fake")?.status).toBe("connected");

    // The session closing is the kernel's context being disposed.
    await open.session.kernel.dispose();
    await until(() => w.host.manager.servers.get("ada", "fake") === undefined);
  });
});

describe("approval, forms and akhook", () => {
  const rule = `version: 1
rules:
  - id: no-echo
    on: tool_call
    tools: ["mcp__fake__echo"]
    checks:
      - regex: '.'
    message: echo is not allowed
`;
  const akhookFor = (open: { session: OpenSession }, yaml: string) =>
    new AkhookSession({
      cwd: "/project",
      ask: open.session.ask,
      userConfigPath: "/nonexistent/akhook.yml",
      additional: () => [{ name: "t", text: yaml }],
    }).middleware;

  it("lets an akhook rule on mcp__<server>__<tool> veto a call through the proxy and a direct tool", async () => {
    const w = await world();
    const sources = [bundle("demo", { fake: fake({ directTools: ["echo"] }) })];
    // Make the direct tool known first.
    const seed = w.openSession();
    w.host.sessionTools({ ...seed, bundles: sources });
    await until(
      () => seed.session.kernel.tools.get("mcp__fake__echo") !== undefined,
    );

    const open = w.openSession();
    const tools = w.host.sessionTools({
      ...open,
      bundles: sources,
      akhook: akhookFor(open, rule),
    });
    for (const tool of tools) open.session.kernel.tools.register(tool);

    const viaProxy = await toolOf(
      open,
      "mcp",
    )({
      tool: "echo",
      server: "fake",
      args: { text: "hi" },
    });
    expect(viaProxy).toMatchObject({ isError: true });
    expect(textOf(viaProxy)).toContain("no-echo");
    expect(textOf(viaProxy)).toContain("echo is not allowed");

    const viaDirect = await toolOf(open, "mcp__fake__echo")({ text: "hi" });
    expect(viaDirect).toMatchObject({ isError: true });
    expect(textOf(viaDirect)).toContain("echo is not allowed");

    // A tool the rule does not name still runs.
    const other = await toolOf(open, "mcp")({ tool: "pid", server: "fake" });
    expect(other).not.toHaveProperty("isError", true);
  });

  it("asks the user before a tool that approveTools names, and runs it only on allow", async () => {
    const w = await world();
    await w.writeProject({ fake: fake({ approveTools: ["echo"] }) });
    const open = w.openSession();
    for (const tool of w.host.sessionTools({ ...open, bundles: [] }))
      open.session.kernel.tools.register(tool);
    const call = () =>
      toolOf(
        open,
        "mcp",
      )({ tool: "echo", server: "fake", args: { text: "x" } });

    w.answers.push(() => ({ kind: "selection", selections: ["deny"] }));
    expect(await call()).toMatchObject({ isError: true });
    expect(w.asked[0]!.question).toContain("mcp__fake__echo");
    expect(w.asked[0]!.options).toEqual(["allow", "deny"]);

    w.answers.push(() => ({ kind: "selection", selections: ["allow"] }));
    expect(textOf(await call())).toContain("x");
  });

  it("turns a flat form into one question per field", async () => {
    const w = await world();
    await w.writeProject({ fake: fake() });
    const open = w.openSession();
    for (const tool of w.host.sessionTools({ ...open, bundles: [] }))
      open.session.kernel.tools.register(tool);
    w.answers.push(
      () => ({ kind: "freeform", text: "Ada" }),
      () => ({ kind: "selection", selections: ["blue"] }),
      () => ({ kind: "selection", selections: ["yes"] }),
      () => ({ kind: "freeform", text: "42" }),
    );
    const result = await toolOf(
      open,
      "mcp",
    )({
      tool: "ask",
      server: "fake",
      args: {
        schema: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name" },
            colour: { type: "string", enum: ["red", "blue"] },
            admin: { type: "boolean" },
            age: { type: "integer" },
          },
          required: ["name", "colour", "admin", "age"],
        },
      },
    });
    expect(textOf(result)).toContain(
      'elicit:accept:{"name":"Ada","colour":"blue","admin":true,"age":42}',
    );
    expect(w.asked.map((question) => question.options)).toEqual([
      undefined,
      ["red", "blue"],
      ["yes", "no"],
      undefined,
    ]);
  });

  it("declines when the user declines, and cancels a form it cannot ask, telling the model why", async () => {
    const w = await world();
    await w.writeProject({ fake: fake() });
    const open = w.openSession();
    for (const tool of w.host.sessionTools({ ...open, bundles: [] }))
      open.session.kernel.tools.register(tool);
    const ask = (schema: unknown) =>
      toolOf(open, "mcp")({ tool: "ask", server: "fake", args: { schema } });

    // Nobody answers: that is a decline.
    const declined = await ask({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(textOf(declined)).toContain("elicit:decline");

    const nested = await ask({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
    });
    expect(textOf(nested)).toContain("elicit:cancel");
    expect(textOf(nested)).toContain("could not be shown");
    expect(textOf(nested)).toContain('"tags"');
    // It was never asked as a question.
    expect(w.asked).toHaveLength(1);
  });
});
