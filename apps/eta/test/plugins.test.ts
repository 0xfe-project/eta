/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * Plugins, end to end through a real host: from a directory to what a session gets.
 *
 * The plugin is `fixtures/plugins/hello-plugin`, a real Agent Plugin with a skill, a stdio MCP
 * server and a configuration; `ap-lint` passes it, and it is a plain plugin to any client that does
 * not know eta's extension. The secrets here are the sentinels `journalFree` looks for: nothing a
 * client is sent and nothing under the data directory may hold them.
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type {
  AgentView,
  PluginAuditView,
  PluginsSections,
  PluginView,
  SessionMcpServer,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { databasePath, openDatabase } from "../src/db";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

const FIXTURE = new URL("./fixtures/plugins/hello-plugin/", import.meta.url)
  .pathname;
const NAME = "hello-plugin";

const API_KEY = "sk-noneLevelSentinel123";
const SCRIPT_KEY = "fileLevelSentinel456";
const PLAIN_KEY = "valueLevelSentinel789";

async function install(dataDir: string): Promise<string> {
  const dir = join(dataDir, "plugins", NAME);
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const views = (w: World): PluginView[] =>
  w.client.section<PluginView[]>("plugins", "list") ?? [];

const view = (w: World, name = NAME): PluginView => {
  const found = views(w).find((plugin) => plugin.name === name);
  if (found === undefined) throw new Error(`no plugin ${name}`);
  return found;
};

async function recheck(w: World): Promise<void> {
  await w.client.call("plugins", "recheck", {});
}

/** A host with the plugin on disk, and a client watching the target. */
async function installed(
  options: Parameters<typeof world>[0] = {},
): Promise<World> {
  const dataDir = await tempDir();
  await install(dataDir);
  const w = await world({ ...options, dataDir });
  w.client.subscribe("plugins");
  await until(() => views(w).length > 0);
  return w;
}

const configure = async (w: World, values: Record<string, unknown>) =>
  await w.client.call("plugins", "configure", { name: NAME, values });

/** Everything a working configuration holds. */
const fullConfig = {
  api_key: API_KEY,
  script_key: SCRIPT_KEY,
  plain_key: PLAIN_KEY,
  team: "ops",
};

async function enable(w: World, agent: AgentView): Promise<AgentView> {
  const { agent: updated } = (await w.client.call("agents", "update", {
    agentId: agent.id,
    plugins: [NAME],
  })) as { agent: AgentView };
  return updated;
}

const agentView = (w: World, id: string): AgentView =>
  w.client
    .section<AgentView[]>("agents", "list")!
    .find((agent) => agent.id === id)!;

async function direct(w: World, agent: AgentView): Promise<string> {
  const { conversation } = (await w.client.call("agents", "direct", {
    agentId: agent.id,
  })) as { conversation: { id: string } };
  await w.watch(conversation.id);
  return conversation.id;
}

/** Say something and wait for the reply to end. */
async function ask(w: World, chat: string, text: string) {
  const sent = await w.send(chat, text);
  return await w.settled(chat, sent.replies[0]!.id);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** No file under `dir` holds any of the values, in the clear. */
function expectNowhere(dir: string, values: readonly string[]): void {
  for (const path of filesUnder(dir)) {
    const content = readFileSync(path).toString("latin1");
    for (const value of values)
      expect(content.includes(value), `${value} in ${path}`).toBe(false);
  }
}

const framesHold = (w: World, value: string): boolean =>
  JSON.stringify(w.client.frames).includes(value);

describe("a plugin in settings", () => {
  it("shows up from its directory, with what it runs and what it asks for", async () => {
    const w = await installed();
    expect(view(w)).toMatchObject({
      version: "1.0.0",
      state: "needs_config",
      problem: null,
      reports: [],
      source: { kind: "local" },
      skills: [{ name: "greet" }],
      requires: ["node"],
      servers: [
        {
          name: "hello",
          transport: "stdio",
          command: ["node", "${PLUGIN_ROOT}/server/hello-mcp.mjs"],
          env: ["HELLO_API_KEY", "HELLO_TEAM", "HELLO_MAX"],
          problem: null,
        },
      ],
    });
    expect(
      view(w).fields.map((field) => [field.name, field.level, field.levels]),
    ).toEqual([
      ["api_key", "none", ["none"]],
      ["script_key", "file", ["none", "file"]],
      ["plain_key", "value", ["none", "file", "value"]],
      ["team", "read", ["none", "read"]],
      ["max_greetings", "read", ["none", "read"]],
      ["loud", "read", ["none", "read"]],
      ["languages", "read", ["none", "read"]],
    ]);
    expect(view(w).machines[0]).toMatchObject({ missing: [], checked: true });
  });

  it("says which commands a machine lacks", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    const dir = await install(w.host.dataDir);
    const manifest = JSON.parse(
      await readFile(join(dir, "plugin.json"), "utf8"),
    ) as { extensions: Record<string, { requires: string[] }> };
    manifest.extensions["tech.0xfe.eta"]!.requires = ["no-such-command-here"];
    await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest));
    await recheck(w);
    await until(() => views(w).length > 0);
    expect(view(w).machines[0]?.missing).toEqual(["no-such-command-here"]);
  });

  it("is read again when its files change", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    const dir = await install(w.host.dataDir);
    await until(() => views(w).length > 0);
    await writeFile(
      join(dir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets differently now.\n---\n\nBody.\n",
    );
    await until(
      () => view(w).skills[0]?.description === "Greets differently now.",
    );
  });

  it("shows a plugin the spec rejects, under its directory's name, with why", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    const dir = join(w.host.dataDir, "plugins", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), '{"name":"x"}');
    await recheck(w);
    await until(() => views(w).length > 0);
    expect(view(w, "broken")).toMatchObject({
      state: "needs_config",
      problem: expect.stringContaining("$schema"),
    });
  });

  it("is not confused by what else lives in that directory", async () => {
    const w = await installed();
    await mkdir(join(w.host.dataDir, "plugins", "data", NAME), {
      recursive: true,
    });
    const server = join(w.host.dataDir, "plugins", "server-plugin");
    await mkdir(server);
    await writeFile(
      join(server, "package.json"),
      JSON.stringify({ name: "server-plugin", "eta-plugin": {} }),
    );
    await recheck(w);
    expect(views(w).map((plugin) => plugin.name)).toEqual([NAME]);
  });

  it("is no broken plugin to the server that shares the directory", async () => {
    const warnings: string[] = [];
    const dataDir = await tempDir();
    await install(dataDir);
    await mkdir(join(dataDir, "plugins", "data", NAME), { recursive: true });
    const host = await testHost({
      dataDir,
      warn: (message) => warnings.push(message),
    });
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    const hello = await client.hello();
    expect(hello.mounted.map((plugin) => plugin.name)).not.toContain(NAME);
    expect(hello.mounted.map((plugin) => plugin.name)).not.toContain("data");
    expect(warnings.filter((text) => text.includes("not running"))).toEqual([]);
    client.close();
  });
});

describe("configuring", () => {
  it("cannot be enabled while something required is missing", async () => {
    const w = await installed();
    const agent = await w.agent("Ada");
    await expect(enable(w, agent)).rejects.toThrow(/needs configuring/);
    await expect(w.agent("Bea", { plugins: [NAME] })).rejects.toThrow(
      /needs configuring/,
    );
    // Another field saved does not change that: `api_key` is what it is waiting for.
    expect(await configure(w, { team: "ops" })).toMatchObject({
      state: "needs_config",
      issues: [{ field: "api_key", code: "required" }],
    });
    await expect(enable(w, agent)).rejects.toThrow(/needs configuring/);
  });

  it("is ready once what it asks for fits, and an agent can enable it", async () => {
    const w = await installed();
    expect(await configure(w, { api_key: API_KEY })).toMatchObject({
      state: "ready",
      issues: [],
    });
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    expect(agent.plugins).toEqual([NAME]);
    expect(agent.skippedPlugins).toEqual([]);
    await until(() => view(w).agents.length === 1);
  });

  it("is checked by the host, and nothing that does not fit is saved", async () => {
    const w = await installed();
    await expect(configure(w, { api_key: "nope" })).rejects.toThrow(
      /api_key: pattern/,
    );
    await expect(configure(w, { max_greetings: 2.5 })).rejects.toThrow(
      /max_greetings: int/,
    );
    await expect(configure(w, { max_greetings: 11 })).rejects.toThrow(
      /max_greetings: max 10/,
    );
    await expect(configure(w, { languages: ["fr"] })).rejects.toThrow(
      /languages: option/,
    );
    await expect(configure(w, { nope: "x" })).rejects.toThrow(/no field nope/);
    await expect(configure(w, { team: { a: 1 } })).rejects.toThrow(
      /not a value/,
    );
    expect(view(w).fields.every((field) => !field.set)).toBe(true);
  });

  it("never sends a secret back, and a blank one changes nothing", async () => {
    const w = await installed();
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const key = (): PluginView["fields"][number] =>
      view(w).fields.find((field) => field.name === "api_key")!;
    expect(key()).toMatchObject({ set: true, value: null });
    await configure(w, { api_key: "" });
    await recheck(w);
    expect(key().set).toBe(true);
    expect(view(w).state).toBe("ready");
    expect(view(w).fields.find((f) => f.name === "team")?.value).toBe("ops");
    for (const secret of [API_KEY, SCRIPT_KEY, PLAIN_KEY])
      expect(framesHold(w, secret)).toBe(false);
    // The database holds them sealed; `null` is how one is taken out.
    expectNowhere(w.host.dataDir, [API_KEY, SCRIPT_KEY, PLAIN_KEY]);
    await configure(w, { api_key: null });
    await until(() => view(w).state === "needs_config");
    expect(key().set).toBe(false);
  });

  it("lets the user lower a level, and never raise it past the manifest", async () => {
    const w = await installed();
    await w.client.call("plugins", "setLevel", {
      name: NAME,
      field: "plain_key",
      level: "file",
    });
    await until(
      () =>
        view(w).fields.find((field) => field.name === "plain_key")?.level ===
        "file",
    );
    // Back up to what the manifest declares is allowed, and past it is not.
    await w.client.call("plugins", "setLevel", {
      name: NAME,
      field: "plain_key",
      level: "value",
    });
    await expect(
      w.client.call("plugins", "setLevel", {
        name: NAME,
        field: "api_key",
        level: "value",
      }),
    ).rejects.toThrow(/cannot be set to value/);
    await expect(
      w.client.call("plugins", "setLevel", {
        name: NAME,
        field: "script_key",
        level: "value",
      }),
    ).rejects.toThrow(/cannot be set to value/);
  });
});

describe("an upgrade that breaks the configuration", () => {
  /** Change the manifest on disk the way a new version would. */
  async function upgrade(
    w: World,
    change: (config: Record<string, Record<string, unknown>>) => void,
  ): Promise<void> {
    const path = join(w.host.dataDir, "plugins", NAME, "plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      extensions: {
        "tech.0xfe.eta": { config: Record<string, Record<string, unknown>> };
      };
    };
    change(manifest.extensions["tech.0xfe.eta"].config);
    await writeFile(path, JSON.stringify(manifest));
    await recheck(w);
  }

  it("goes back to needing configuration, and the agent skips it and says so", async () => {
    const w = await installed({
      models: scriptedModels(() => say("ok")).models,
    });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));

    // A new required field, and a saved value that no longer fits.
    await upgrade(w, (config) => {
      config.region = { type: "string", required: true };
      config.team!.maxLength = 1;
    });
    await until(() => view(w).state === "needs_config");
    expect(
      view(w).fields.find((field) => field.name === "team")?.issue,
    ).toEqual({ field: "team", code: "maxLength", limit: 1 });
    expect(
      view(w).fields.find((field) => field.name === "region")?.issue,
    ).toEqual({ field: "region", code: "required" });
    await until(() => agentView(w, agent.id).skippedPlugins.length === 1);
    expect(agentView(w, agent.id).plugins).toEqual([NAME]);
  });

  it("leaves it out of the session until it is fixed", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    const chat = await direct(w, agent);
    await ask(w, chat, "first");
    const systemOf = () => requests.at(-1)!.system;
    expect(systemOf()).toContain("greet");

    await upgrade(w, (config) => {
      config.region = { type: "string", required: true };
    });
    await until(() => view(w).state === "needs_config");
    await ask(w, chat, "second");
    expect(systemOf()).not.toContain("hello-plugin");

    await configure(w, { region: "eu" });
    await until(() => view(w).state === "ready");
    await ask(w, chat, "third");
    expect(systemOf()).toContain("hello-plugin");
  });

  it("keeps an enabled agent on a level the manifest took away", async () => {
    const w = await installed();
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    await w.client.call("plugins", "setLevel", {
      name: NAME,
      field: "plain_key",
      level: "value",
    });
    await upgrade(w, (config) => {
      config.plain_key!.agent = "none";
    });
    await until(
      () =>
        view(w).fields.find((field) => field.name === "plain_key")?.level ===
        "none",
    );
  });
});

describe("a session on eta's own loop", () => {
  it("has the plugin's skill, a file it can read, and no MCP server", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    await ask(w, await direct(w, agent), "hello");
    const { system } = requests.at(-1)!;
    expect(system).toContain("greet");
    expect(system).toContain("How to greet someone");
    const dir = join(w.host.dataDir, "plugins", NAME);
    expect(system).toContain(join(dir, "skills", "greet", "SKILL.md"));
    for (const secret of [API_KEY, SCRIPT_KEY, PLAIN_KEY])
      expect(system).not.toContain(secret);
  });

  it("does not have a plugin its agent did not enable", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await w.agent("Ada");
    await ask(w, await direct(w, agent), "hello");
    expect(requests.at(-1)!.system).not.toContain("hello-plugin");
  });

  it("reopens when the plugin's files or values change", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    const chat = await direct(w, agent);
    await ask(w, chat, "one");
    expect(requests.at(-1)!.system).toContain("How to greet someone");
    await writeFile(
      join(w.host.dataDir, "plugins", NAME, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets in a new way.\n---\n\nBody.\n",
    );
    await ask(w, chat, "two");
    expect(requests.at(-1)!.system).toContain("Greets in a new way.");
  });
});

/** What `get_plugin_config` answered, parsed. */
function fieldsOf(text: string): Record<string, Record<string, unknown>> {
  return (
    JSON.parse(text) as { fields: Record<string, Record<string, unknown>> }
  ).fields;
}

describe("get_plugin_config", () => {
  /** An agent whose model calls the tool, once, with these arguments, then stops. */
  async function reading(
    args: Record<string, unknown>,
    enabled = true,
  ): Promise<{ w: World; agent: AgentView; result: string; isError: boolean }> {
    let result: string | undefined;
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        result = request.last;
        return say("done");
      }
      return call("get_plugin_config", args);
    });
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    let agent = await w.agent("Ada");
    if (enabled) agent = await enable(w, agent);
    await ask(w, await direct(w, agent), "read it");
    return {
      w,
      agent,
      result: result!,
      isError: !result!.startsWith("{"),
    };
  }

  it("answers each field at its level, and keeps the others' values out", async () => {
    const { w, result, agent } = await reading({ plugin: NAME });
    const fields = fieldsOf(result);
    expect(fields.team).toEqual({ level: "read", value: "ops" });
    // A default is the value in force.
    expect(fields.max_greetings).toEqual({ level: "read", value: 3 });
    expect(fields.plain_key).toEqual({ level: "value", value: PLAIN_KEY });
    expect(fields.api_key).toMatchObject({ level: "none", readable: false });
    expect(String(fields.api_key!.note)).toContain("Not readable");
    expect(result).not.toContain(API_KEY);
    expect(result).not.toContain(SCRIPT_KEY);

    const path = String(fields.script_key!.path);
    expect(fields.script_key!.level).toBe("file");
    expect(await readFile(path, "utf8")).toBe(SCRIPT_KEY);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await rm(join(path, ".."), { recursive: true, force: true });

    // The reads of a secret are on record, and the record has no value in it.
    await w.client.subscribe("plugins");
    await until(
      () =>
        (w.client.section<PluginAuditView[]>("plugins", "audit")?.length ?? 0) >
        0,
    );
    const audit = w.client.section<PluginAuditView[]>("plugins", "audit")!;
    expect(
      audit.map((row) => [row.agentName, row.plugin, row.field, row.level]),
    ).toEqual(
      expect.arrayContaining([
        [agent.name, NAME, "script_key", "file"],
        [agent.name, NAME, "plain_key", "value"],
      ]),
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]?.sessionId).toMatch(/\S/);
    expect(JSON.stringify(audit)).not.toContain(PLAIN_KEY);
  });

  it("reads only the fields asked for", async () => {
    const { result } = await reading({
      plugin: NAME,
      fields: ["team", "typo"],
    });
    expect(fieldsOf(result)).toEqual({
      team: { level: "read", value: "ops" },
      typo: { error: "No such field." },
    });
  });

  it("does not read a plugin the agent has not enabled", async () => {
    const { result, isError, w } = await reading({ plugin: NAME }, false);
    expect(isError).toBe(true);
    expect(result).toContain("not enabled");
    expect(result).toContain("Enabled: none.");
    const db = openDatabase(databasePath(w.host.dataDir));
    expect(db.query("SELECT COUNT(*) AS n FROM plugin_audit").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("follows a level the user lowered", async () => {
    let result = "";
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        result = request.last;
        return say("done");
      }
      return call("get_plugin_config", { plugin: NAME });
    });
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    for (const [field, level] of [
      ["plain_key", "none"],
      ["script_key", "none"],
      ["team", "none"],
    ])
      await w.client.call("plugins", "setLevel", { name: NAME, field, level });
    const agent = await enable(w, await w.agent("Ada"));
    await ask(w, await direct(w, agent), "read it");
    const fields = fieldsOf(result);
    expect(fields.plain_key?.level).toBe("none");
    expect(fields.script_key?.level).toBe("none");
    expect(fields.team?.level).toBe("none");
    expect(result).not.toContain(PLAIN_KEY);
    expect(result).not.toContain(SCRIPT_KEY);
    expect(result).not.toContain("ops");
  });
});

describe("eta.platform.get_plugin_config", () => {
  it("is there for a script, and keeps to the same levels", async () => {
    let told = "";
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        told = request.last;
        return say("done");
      }
      return call("esmrun", {
        script: `import eta from "eta";
await eta.platform.get_plugin_config({ plugin: "${NAME}", fields: ["team", "api_key"] })`,
      });
    });
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    await ask(w, await direct(w, agent), "read it from a script");
    expect(told).toContain("ops");
    expect(told).toContain("Not readable");
    expect(told).not.toContain(API_KEY);
  });
});

describe("what a session on eta's own loop keeps", () => {
  it("takes secrets out of a tool's output before the model and the journal see it", async () => {
    let told = "";
    const leaked = join(await tempDir("eta-leak-"), "found");
    await writeFile(leaked, API_KEY);
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        told = request.last;
        return say("done");
      }
      return call("esmrun", {
        script: `import { readFileSync } from "node:fs";
"it is " + readFileSync(${JSON.stringify(leaked)}, "utf8")`,
      });
    });
    const w = await installed({ models });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Ada"));
    await ask(w, await direct(w, agent), "print it");
    expect(told).toContain("[secret hello-plugin.api_key]");
    expect(told).not.toContain(API_KEY);
    expect(framesHold(w, API_KEY)).toBe(false);
    expectNowhere(join(w.host.dataDir, "sessions"), [API_KEY]);
  });
});

describe("a session on an external runtime", () => {
  async function onClaude(
    options: { turn?: (turn: ScriptedTurn) => Promise<void> } = {},
  ) {
    const turns: ScriptedTurn[] = [];
    const w = await installed({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "claude",
            turn: async (turn) => {
              turns.push(turn);
              await options.turn?.(turn);
              turn.say("ok");
            },
          }),
        ]),
      }),
    });
    return { w, turns };
  }

  const pluginServer = (turn: ScriptedTurn) => {
    const server = turn.options.mcpServers?.find(
      (entry) => entry.name === "hello-plugin-hello",
    );
    if (server === undefined || !("command" in server))
      throw new Error("the session was not given the plugin's server");
    return server;
  };

  it("is given the server, with its configuration only in the server's environment", async () => {
    const { w, turns } = await onClaude();
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Cody", { runtime: "claude" }));
    await ask(w, await direct(w, agent), "hi");
    const server = pluginServer(turns[0]!);
    expect(server.env).toMatchObject({
      HELLO_API_KEY: API_KEY,
      HELLO_TEAM: "ops",
      HELLO_MAX: "3",
      PLUGIN_ROOT: join(w.host.dataDir, "plugins", NAME),
      PLUGIN_DATA: join(w.host.dataDir, "plugins", "data", NAME),
    });
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    for (const secret of [API_KEY, SCRIPT_KEY, PLAIN_KEY])
      expect(prompt).not.toContain(secret);
    // Claude Code takes the skills natively, from a directory of nothing else.
    const [flag, dir] = turns[0]!.options.launchArgs ?? [];
    expect(flag).toBe("--plugin-dir");
    expect(readdirSync(join(dir!, "skills"))).toEqual(["greet"]);
    expect(framesHold(w, API_KEY)).toBe(false);
    expectNowhere(w.host.dataDir, [API_KEY]);
  });

  it("hears of the skills in its prompt where it has no way of its own", async () => {
    const turns: ScriptedTurn[] = [];
    const w = await installed({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "codex",
            turn: async (turn) => {
              turns.push(turn);
              turn.say("ok");
            },
          }),
        ]),
      }),
    });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Cody", { runtime: "codex" }));
    await ask(w, await direct(w, agent), "hi");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt).toContain("<name>greet</name>");
    expect(prompt).toContain(
      join(w.host.dataDir, "plugins", NAME, "skills", "greet", "SKILL.md"),
    );
    expect(turns[0]!.options.launchArgs).toBeUndefined();
  });

  it("gets a server that really runs, with those values", async () => {
    const { w, turns } = await onClaude();
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Cody", { runtime: "claude" }));
    await ask(w, await direct(w, agent), "hi");
    const answer = await callServer(pluginServer(turns[0]!));
    const sha256 = (text: string): string =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(answer).toMatchObject({
      greeting: "Hello Ada from ops",
      max: "3",
      cwd: join(w.host.dataDir, "plugins", NAME),
      root: join(w.host.dataDir, "plugins", NAME),
      data: join(w.host.dataDir, "plugins", "data", NAME),
      keySha256: sha256(API_KEY),
    });
    // It wrote where `PLUGIN_DATA` is, and that stays when the plugin is updated.
    const log = join(w.host.dataDir, "plugins", "data", NAME, "greetings.log");
    expect(await readFile(log, "utf8")).toBe("Ada\n");
  });

  it("is reopened with the new value when the configuration changes", async () => {
    const { w, turns } = await onClaude();
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Cody", { runtime: "claude" }));
    const chat = await direct(w, agent);
    await ask(w, chat, "one");
    await configure(w, { team: "new-team" });
    await ask(w, chat, "two");
    expect(pluginServer(turns.at(-1)!).env?.HELLO_TEAM).toBe("new-team");
  });

  it("reads config through the same tool, served over MCP", async () => {
    let answer = "";
    const { w } = await onClaude({
      turn: async (turn) => {
        answer = await callHostTool(turn, "get_plugin_config", {
          plugin: NAME,
        });
      },
    });
    await configure(w, fullConfig);
    await until(() => view(w).state === "ready");
    const agent = await enable(w, await w.agent("Cody", { runtime: "claude" }));
    await ask(w, await direct(w, agent), "hi");
    const fields = fieldsOf(answer);
    expect(fields.team).toEqual({ level: "read", value: "ops" });
    expect(fields.plain_key).toEqual({ level: "value", value: PLAIN_KEY });
    expect(fields.api_key?.level).toBe("none");
    expect(answer).not.toContain(API_KEY);
    expect(answer).not.toContain(SCRIPT_KEY);
    const path = String(fields.script_key?.path);
    expect(await readFile(path, "utf8")).toBe(SCRIPT_KEY);
    await rm(join(path, ".."), { recursive: true, force: true });
  });
});

/** One of eta's tools, the way Claude Code calls it: over the MCP server the session was given. */
async function callHostTool(
  turn: ScriptedTurn,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = turn.options.mcpServers?.find((entry) => entry.name === "eta");
  if (server === undefined || !("url" in server))
    throw new Error("the session was not given eta's tools");
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const reply = (await response.json()) as {
    result: { content: { text?: string }[] };
  };
  return reply.result.content.map((part) => part.text ?? "").join("");
}

/** The MCP handshake and one tool call, over stdio, the way a runtime would make them. */
async function callServer(
  server: Pick<Extract<SessionMcpServer, { command: string }>, "command"> & {
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<unknown> {
  const child = Bun.spawn([server.command, ...(server.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    env: { PATH: process.env.PATH ?? "", ...server.env },
  });
  const lines = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "say_hello", arguments: { name: "Ada" } },
    },
  ];
  child.stdin.write(
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  await child.stdin.flush();
  const reader = child.stdout.getReader();
  let text = "";
  while (text.split("\n").filter((line) => line !== "").length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  child.kill();
  const reply = JSON.parse(text.trim().split("\n")[1]!) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(reply.result.content[0]!.text);
}

describe("a session on a daemon's machine", () => {
  async function remote(runtime: "eta" | "claude") {
    const turns: ScriptedTurn[] = [];
    const { models, requests } = scriptedModels(() => say("ok"));
    const r = await remoteWorld(
      { models },
      {
        node: {
          runtimes: createOarRuntimes({
            registry: createRuntimeRegistry([
              scriptedRuntime({
                id: "claude",
                turn: async (turn) => {
                  turns.push(turn);
                  turn.say("ok");
                },
              }),
            ]),
          }),
        },
      },
    );
    r.client.subscribe("plugins");
    await install(r.host.dataDir);
    await recheck(r);
    await until(() => views(r).length > 0);
    await configure(r, fullConfig);
    await until(() => view(r).state === "ready");
    const agent = await enable(
      r,
      await r.agent("Rem", runtime === "eta" ? {} : { runtime }),
    );
    const group = await r.group(r.remoteProject.id, [agent.id]);
    await r.watch(group.id);
    return { r, agent, group, turns, requests };
  }

  const inStore = (dataDir: string, ...parts: string[]): string => {
    const root = join(dataDir, "plugins", "store");
    const [hash] = readdirSync(root).filter((name) => !name.endsWith(".part"));
    return join(root, hash!, ...parts);
  };

  it("gets the files, and a skill from its own copy", async () => {
    const { r, group, requests } = await remote("eta");
    await ask(r, group.id, "hello");
    const skill = inStore(r.daemon.dataDir, "skills", "greet", "SKILL.md");
    expect(statSync(skill).isFile()).toBe(true);
    expect(requests.at(-1)!.system).toContain(skill);
    // eta's own loop starts no server, so the values have no reason to cross.
    expect(r.traffic.in.join("").includes(API_KEY)).toBe(true); // redactions
    expect(r.traffic.in.join("").includes("HELLO_API_KEY")).toBe(false);
  });

  it("gives a runtime there the server, with paths of that machine, and keeps nothing on disk", async () => {
    const { r, group, turns } = await remote("claude");
    await ask(r, group.id, "hello");
    const server = turns[0]!.options.mcpServers?.find(
      (entry) => entry.name === "hello-plugin-hello",
    );
    if (server === undefined || !("command" in server))
      throw new Error("no server");
    expect(server.env).toMatchObject({
      HELLO_API_KEY: API_KEY,
      PLUGIN_ROOT: inStore(r.daemon.dataDir),
      PLUGIN_DATA: join(r.daemon.dataDir, "plugins", "data", NAME),
    });
    expectNowhere(r.daemon.dataDir, [API_KEY, SCRIPT_KEY, PLAIN_KEY]);
    expect(statSync(server.env!.PLUGIN_DATA!).isDirectory()).toBe(true);
  });

  it("sends files only once, and again when they change", async () => {
    const { r, group } = await remote("eta");
    await ask(r, group.id, "one");
    const puts = () =>
      r.traffic.in.filter((frame) => frame.includes('"pluginPut"')).length;
    const first = puts();
    expect(first).toBeGreaterThan(0);
    await ask(r, group.id, "two");
    expect(puts()).toBe(first);
    await writeFile(
      join(r.host.dataDir, "plugins", NAME, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets anew.\n---\n\nBody.\n",
    );
    await ask(r, group.id, "three");
    expect(puts()).toBeGreaterThan(first);
  });

  it("writes a file-level value on the session's machine", async () => {
    let result = "";
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        result = request.last;
        return say("done");
      }
      return call("get_plugin_config", {
        plugin: NAME,
        fields: ["script_key"],
      });
    });
    const r = await remoteWorld({ models });
    r.client.subscribe("plugins");
    await install(r.host.dataDir);
    await recheck(r);
    await until(() => views(r).length > 0);
    await configure(r, fullConfig);
    await until(() => view(r).state === "ready");
    const agent = await enable(r, await r.agent("Rem"));
    const group = await r.group(r.remoteProject.id, [agent.id]);
    await r.watch(group.id);
    await ask(r, group.id, "read it");
    const fields = fieldsOf(result);
    expect(fields.script_key?.level).toBe("file");
    const path = String(fields.script_key?.path);
    expect(await readFile(path, "utf8")).toBe(SCRIPT_KEY);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await rm(join(path, ".."), { recursive: true, force: true });
  });

  it("asks a daemon which commands it has", async () => {
    const r = await remoteWorld();
    r.client.subscribe("plugins");
    await install(r.host.dataDir);
    await recheck(r);
    await until(() => view(r).machines.length === 2);
    expect(view(r).machines[1]).toMatchObject({ missing: [], checked: true });
  });
});

describe("a plugin from git", () => {
  async function repo(): Promise<{
    url: string;
    commit: (text: string) => Promise<void>;
  }> {
    const dir = await tempDir("eta-plugin-repo-");
    const git = async (...args: string[]) => {
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
      if ((await child.exited) !== 0)
        throw new Error(await new Response(child.stderr).text());
    };
    await git("init", "-q", "-b", "main");
    await git("config", "uploadpack.allowAnySHA1InWant", "true");
    await cp(FIXTURE, join(dir, "sub"), { recursive: true });
    const commit = async (text: string): Promise<void> => {
      await writeFile(
        join(dir, "sub", "skills", "greet", "SKILL.md"),
        `---\nname: greet\ndescription: ${text}\n---\n\nBody.\n`,
      );
      await git("add", ".");
      await git("commit", "-qm", text);
    };
    await commit("first version");
    return { url: `file://${dir}`, commit };
  }

  it("stays at the commit it was added at until asked to update", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    const { url, commit } = await repo();
    await w.client.call("plugins", "add", {
      repo: url,
      rev: "main",
      path: "sub",
    });
    await until(() => views(w).length > 0);
    const first = view(w);
    expect(first.source).toMatchObject({ kind: "git", repo: url, rev: "main" });
    expect(first.skills[0]?.description).toBe("first version");
    const sha = (first.source as { sha: string }).sha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    await commit("second version");
    await recheck(w);
    expect(view(w).skills[0]?.description).toBe("first version");

    await w.client.call("plugins", "update", { name: NAME });
    await until(() => view(w).skills[0]?.description === "second version");
    expect((view(w).source as { sha: string }).sha).not.toBe(sha);
  });

  it("keeps PLUGIN_DATA and the configuration across an update", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    const { url, commit } = await repo();
    await w.client.call("plugins", "add", {
      repo: url,
      rev: "main",
      path: "sub",
    });
    await until(() => views(w).length > 0);
    await configure(w, fullConfig);
    const data = join(w.host.dataDir, "plugins", "data", NAME);
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "kept"), "x");
    await commit("second version");
    await w.client.call("plugins", "update", {});
    await until(() => view(w).skills[0]?.description === "second version");
    expect(await readFile(join(data, "kept"), "utf8")).toBe("x");
    expect(view(w).state).toBe("ready");
  });

  it("is removed, and a local one cannot be", async () => {
    const w = await installed();
    await expect(
      w.client.call("plugins", "remove", { name: NAME }),
    ).rejects.toThrow(/not from git/);
    const { url } = await repo();
    await expect(
      w.client.call("plugins", "add", { repo: url, rev: "main", path: "sub" }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses a repository git would read as an option or a command", async () => {
    const w = await world();
    await expect(
      w.client.call("plugins", "add", { repo: "--upload-pack=touch /tmp/x" }),
    ).rejects.toThrow(/not a repository/);
    await expect(
      w.client.call("plugins", "add", { repo: "ext::sh -c 'touch /tmp/x'" }),
    ).rejects.toThrow(/cannot read/);
  });
});

describe("the plugins target", () => {
  it("says nothing of a host's plugins it was not asked about", async () => {
    const w = await world();
    w.client.subscribe("plugins");
    await until(
      () =>
        w.client.section<PluginsSections["list"]>("plugins", "list") !==
        undefined,
    );
    expect(views(w)).toEqual([]);
  });
});
