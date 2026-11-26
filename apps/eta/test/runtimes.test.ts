/**
 * Agents on an external runtime (Claude Code, Codex, ...), through a real socket, with oar's
 * scripted runtime standing in for the binary.
 *
 * What these pin: an agent names its runtime and a model in that runtime's names, and nothing
 * else; the editor can ask what the machine has; a conversation with such an agent is answered by
 * the runtime, tool calls included, and never by eta's own models; an edit of the model reaches
 * the runtime; and an agent moved to another runtime starts its conversations over.
 */
import type { CompactionOutcome, Runtime, Session } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type {
  AgentRuntimeInfo,
  AgentView,
  ArtifactView,
  ToolActivity,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { antigravityRuntime, createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";
import { world } from "./support/world";

/** A host whose Claude Code is a script, and whose eta models must never be asked. */
async function onClaude(
  turn: (turn: ScriptedTurn) => void | Promise<void>,
): Promise<{ w: World; turns: ScriptedTurn[]; etaRequests: unknown[] }> {
  const turns: ScriptedTurn[] = [];
  const { models, requests } = scriptedModels(() => {
    throw new Error("an eta model was asked");
  });
  const w = await world({
    models,
    runtimes: createOarRuntimes({
      registry: createRuntimeRegistry([
        scriptedRuntime({
          id: "claude",
          turn: async (scripted) => {
            turns.push(scripted);
            await turn(scripted);
          },
        }),
      ]),
    }),
  });
  return { w, turns, etaRequests: requests };
}

/** Call one of eta's tools the way Claude Code does: over the MCP server the session was given. */
async function callHostTool(
  turn: ScriptedTurn,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
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
    result?: { content: { text?: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (reply.result === undefined)
    throw new Error(reply.error?.message ?? "no result");
  return {
    text: reply.result.content.map((part) => part.text ?? "").join(""),
    isError: reply.result.isError === true,
  };
}

/** A group of the agent alone, in its own workspace. */
async function alone(w: World, agent: AgentView) {
  const conversation = await w.group(
    agent.homeProjectId,
    [agent.id],
    agent.name,
  );
  await w.watch(conversation.id);
  return conversation.id;
}

describe("an agent's runtime", () => {
  it("is eta unless named, and takes only its own models", async () => {
    const { w } = await onClaude(() => undefined);
    expect(await w.agent("Ada")).toMatchObject({ runtime: "eta" });
    expect(
      await w.agent("Cody", { runtime: "claude", model: "claude:sonnet" }),
    ).toMatchObject({ runtime: "claude", model: "claude:sonnet" });
    expect(await w.agent("Def", { runtime: "claude" })).toMatchObject({
      runtime: "claude",
      model: null,
    });
    await expect(
      w.agent("Bad", { runtime: "claude", model: "anthropic:claude" }),
    ).rejects.toThrow(/claude:<model>/);
    await expect(w.agent("Bad", { runtime: "nope" as never })).rejects.toThrow(
      /unknown runtime/,
    );
  });

  it("moving to another runtime clears a model that named the old one", async () => {
    const { w } = await onClaude(() => undefined);
    const agent = await w.agent("Ada", { model: "fake:model" });
    const { agent: moved } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
      machineId: w.host.db
        .query<{ id: string }, []>(
          "SELECT id FROM machine WHERE kind = 'primary'",
        )
        .get()!.id,
    })) as { agent: AgentView };
    expect(moved).toMatchObject({ runtime: "claude", model: null });
  });

  it("lists what the machine has, for the editor", async () => {
    const { w } = await onClaude(() => undefined);
    const { runtimes } = (await w.client.call("agents", "runtimes", {})) as {
      runtimes: AgentRuntimeInfo[];
    };
    expect(runtimes.map((runtime) => runtime.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "antigravity",
      "grok",
      "qwen",
    ]);
    // The scripted one is there; the others are not in this registry at all.
    expect(runtimes[0]).toMatchObject({
      label: "Claude Code",
      status: "available",
    });
    expect(
      runtimes.slice(1).every((runtime) => runtime.status === "error"),
    ).toBe(true);
  });
});

describe("a runtime's account, read only", () => {
  /** A Claude Code that says who it is signed in as and what of its plan is used. */
  const signedIn = (): Runtime => ({
    ...scriptedRuntime({ id: "claude", turn: (turn) => turn.say("ok") }),
    authStatus: async () => ({
      kind: "logged_in" as const,
      source: "claude auth status",
      account: { email: "ada@example.com", plan: "max", method: "claude.ai" },
    }),
    accountUsage: async () => ({
      kind: "available" as const,
      plan: "max",
      email: "ada@example.com",
      rateLimited: false,
      windows: [
        {
          label: "5h",
          usedRatio: 0.25,
          resetsAt: "2026-11-18T12:00:00.000Z" as never,
        },
      ],
    }),
  });
  const expected = {
    auth: {
      kind: "logged_in",
      email: "ada@example.com",
      plan: "max",
      method: "claude.ai",
    },
    usage: {
      kind: "available",
      plan: "max",
      email: "ada@example.com",
      rateLimited: false,
      windows: [
        { label: "5h", usedRatio: 0.25, resetsAt: "2026-11-18T12:00:00.000Z" },
      ],
    },
  };

  it("is the runtime's own answer on the primary, and nothing for one that has no way to say", async () => {
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          signedIn(),
          scriptedRuntime({ id: "opencode", turn: (turn) => turn.say("ok") }),
        ]),
      }),
    });
    expect(
      await w.client.call("agents", "runtimeAccount", { runtime: "claude" }),
    ).toEqual({ account: expected });
    // OpenCode has neither query: no part is made up for it.
    expect(
      await w.client.call("agents", "runtimeAccount", { runtime: "opencode" }),
    ).toEqual({ account: {} });
    await expect(
      w.client.call("agents", "runtimeAccount", { runtime: "acp.nope" }),
    ).rejects.toThrow(/no such runtime/);
  });

  it("keeps the sign-in when the usage read fails", async () => {
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          {
            ...signedIn(),
            accountUsage: async () => {
              throw new Error("usage endpoint timed out");
            },
          },
        ]),
      }),
    });
    expect(
      await w.client.call("agents", "runtimeAccount", { runtime: "claude" }),
    ).toEqual({
      account: {
        auth: expected.auth,
        usage: { kind: "error", detail: "usage endpoint timed out" },
      },
    });
  });

  it("is asked of a daemon over its link", async () => {
    const r = await remoteWorld(
      {},
      {
        node: {
          runtimes: createOarRuntimes({
            registry: createRuntimeRegistry([signedIn()]),
          }),
        },
      },
    );
    expect(
      await r.client.call("agents", "runtimeAccount", {
        runtime: "claude",
        machineId: r.daemon.machineId,
      }),
    ).toEqual({ account: expected });
  });
});

describe("a conversation with an agent on Claude Code", () => {
  it("is answered by the runtime, with its tool calls, and never by eta's models", async () => {
    const { w, turns, etaRequests } = await onClaude(async (turn) => {
      turn.say("Let me look. ");
      await turn.tool("Bash", '{"command":"ls"}', () => "README.md");
      turn.say("There is a README.");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
      instructions: "Be terse.",
    });
    const chat = await alone(w, agent);
    const sent = await w.send(chat, "what is here?");
    const done = await w.settled(chat, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("There is a README.");
    expect(
      ((done.data as { activity?: ToolActivity[] }).activity ?? []).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Bash"]);
    expect(turns[0]!.input).toContain("what is here?");
    expect(turns[0]!.options.model).toBe("sonnet");
    expect(turns[0]!.options.appendSystemPrompt).toContain("Be terse.");
    expect(etaRequests).toEqual([]);
  });

  it("an edit of the agent's model reaches the runtime", async () => {
    const { w, turns } = await onClaude((turn) => turn.say("ok"));
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const chat = await alone(w, agent);
    await w.settled(chat, (await w.send(chat, "one")).replies[0]!.id);
    await w.client.call("agents", "update", {
      agentId: agent.id,
      model: "claude:opus",
    });
    await w.settled(chat, (await w.send(chat, "two")).replies[0]!.id);
    expect(turns.map((turn) => turn.options.model)).toEqual(["sonnet", "opus"]);
    // The same runtime conversation, on the new model.
    expect(turns[1]!.options.resume).toBeDefined();
  });

  it("an agent moved off eta answers on the runtime from the next message", async () => {
    const { w, turns } = await onClaude((turn) => turn.say("from claude"));
    const agent = await w.agent("Ada", { model: "fake:model" });
    const chat = await alone(w, agent);
    await w
      .settled(chat, (await w.send(chat, "one")).replies[0]!.id)
      .catch(() => undefined);
    await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
      machineId: w.host.db
        .query<{ id: string }, []>(
          "SELECT id FROM machine WHERE kind = 'primary'",
        )
        .get()!.id,
    });
    const done = await w.settled(
      chat,
      (await w.send(chat, "two")).replies[0]!.id,
    );
    expect(done.text).toBe("from claude");
    expect(turns).toHaveLength(1);
    // A new runtime conversation: nothing to resume.
    expect(turns[0]!.options.resume).toBeUndefined();
  });
});

describe("eta's tools, called by an agent on Claude Code", () => {
  it("publish_artifact reads the project's directory on eta's side and publishes it", async () => {
    const results: { text: string; isError: boolean }[] = [];
    const { w } = await onClaude(async (turn) => {
      await turn.tool("mcp__eta__publish_artifact", "{}", async () => {
        const result = await callHostTool(turn, "publish_artifact", {
          path: "site",
          title: "Page",
        });
        results.push(result);
        return result.text;
      });
      turn.say("published");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const project = await w.project();
    await mkdir(join(project.path, "site"), { recursive: true });
    await writeFile(join(project.path, "site", "index.html"), "<h1>hi</h1>");
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    w.client.subscribe("artifacts");
    const sent = await w.send(group.id, "publish the site", {
      mentions: [agent.id],
    });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]!.text).toMatch(
      /Published "Page" as artifact \S+, version 1/,
    );

    const artifacts = () =>
      w.client.section<ArtifactView[]>("artifacts", "list") ?? [];
    await until(() => artifacts().length === 1);
    expect(artifacts()[0]).toMatchObject({
      title: "Page",
      publisherAgentId: agent.id,
    });
    const id = artifacts()[0]!.id;
    expect(
      await readFile(
        join(w.host.dataDir, "artifacts", id, "1", "files", "index.html"),
        "utf8",
      ),
    ).toBe("<h1>hi</h1>");
  });

  it("publish_artifact is told as eta's, with its details, on the transcript and on the row", async () => {
    const publish = (turn: ScriptedTurn, args: Record<string, unknown>) =>
      turn.tool(
        "mcp__eta__publish_artifact",
        JSON.stringify(args),
        async () => {
          const result = await callHostTool(turn, "publish_artifact", args);
          return result.text;
        },
      );
    const { w } = await onClaude(async (turn) => {
      // Two calls of the one tool at once, over the server the runtime was really given.
      await Promise.all([
        publish(turn, { path: "site", title: "Page" }),
        publish(turn, { path: "other", title: "Other" }),
      ]);
      turn.say("published");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const project = await w.project();
    for (const dir of ["site", "other"]) {
      await mkdir(join(project.path, dir), { recursive: true });
      await writeFile(join(project.path, dir, "index.html"), `<h1>${dir}</h1>`);
    }
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    w.client.subscribe("artifacts");
    const sent = await w.send(group.id, "publish both", {
      mentions: [agent.id],
    });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");

    const artifacts = () =>
      w.client.section<ArtifactView[]>("artifacts", "list") ?? [];
    await until(() => artifacts().length === 2);
    const idOf = (title: string): string =>
      artifacts().find((artifact) => artifact.title === title)!.id;
    const activity = (done.data as { activity: ToolActivity[] }).activity;
    expect(activity.map((call) => call.name)).toEqual([
      "publish_artifact",
      "publish_artifact",
    ]);
    expect(
      activity.map((call) => ({
        status: call.status,
        title: (call.input as { title: string }).title,
        details: call.details,
      })),
    ).toEqual([
      {
        status: "completed",
        title: "Page",
        details: {
          artifactId: idOf("Page"),
          title: "Page",
          version: 1,
          files: 1,
        },
      },
      {
        status: "completed",
        title: "Other",
        details: {
          artifactId: idOf("Other"),
          title: "Other",
          version: 1,
          files: 1,
        },
      },
    ]);
  });

  it("publish_artifact on an artifact it already published says the next version", async () => {
    const versions: unknown[] = [];
    const publishes: Record<string, unknown>[] = [];
    const { w } = await onClaude(async (turn) => {
      const args = publishes.shift()!;
      await turn.tool(
        "mcp__eta__publish_artifact",
        JSON.stringify(args),
        async () => (await callHostTool(turn, "publish_artifact", args)).text,
      );
      turn.say("published");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const project = await w.project();
    await mkdir(join(project.path, "site"), { recursive: true });
    await writeFile(join(project.path, "site", "index.html"), "<h1>hi</h1>");
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    const publishOnce = async (args: Record<string, unknown>) => {
      publishes.push(args);
      const sent = await w.send(group.id, "publish", { mentions: [agent.id] });
      const done = await w.settled(group.id, sent.replies[0]!.id);
      const [call] = (done.data as { activity: ToolActivity[] }).activity;
      expect(call!.name).toBe("publish_artifact");
      versions.push((call!.details as { version: number }).version);
      return (call!.details as { artifactId: string }).artifactId;
    };
    const artifactId = await publishOnce({ path: "site", title: "Page" });
    expect(await publishOnce({ path: "site", title: "Page", artifactId })).toBe(
      artifactId,
    );
    expect(versions).toEqual([1, 2]);
  });
});

describe("eta's tools, called by an agent on Antigravity through the stdio MCP bridge", () => {
  it("executes host tools cleanly over stdio + SessionOptions.env and strips toolSummary", async () => {
    const scripted = scriptedRuntime({
      id: "antigravity",
      turn: async (turn) => {
        const server = turn.options.mcpServers?.find(
          (entry) => entry.name === "eta",
        );
        if (server === undefined || "type" in server)
          throw new Error("expected stdio MCP bridge for eta");
        const args = {
          path: "site",
          title: "Bridge Page",
          toolSummary: "Publish Bridge Page",
        };
        await turn.tool(
          "mcp_eta_publish_artifact",
          JSON.stringify(args),
          async () => {
            const childEnv: Record<string, string | undefined> = {
              ...process.env,
            };
            for (const [key, value] of Object.entries(turn.options.env ?? {})) {
              if (value === null) delete childEnv[key];
              else if (value !== undefined) childEnv[key] = value;
            }
            const child = spawn(server.command, [...(server.args ?? [])], {
              env: childEnv,
              stdio: ["pipe", "pipe", "pipe"],
            });
            const lines: Record<string, unknown>[] = [];
            const waiters: ((msg: Record<string, unknown>) => void)[] = [];
            const decoder = new TextDecoder();
            let buffer = "";
            child.stdout.on("data", (chunk: Uint8Array) => {
              buffer += decoder.decode(chunk, { stream: true });
              for (
                let nl = buffer.indexOf("\n");
                nl >= 0;
                nl = buffer.indexOf("\n")
              ) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line === "") continue;
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const waiter = waiters.shift();
                if (waiter !== undefined) waiter(parsed);
                else lines.push(parsed);
              }
            });
            const next = async () =>
              lines.shift() ??
              (await new Promise<Record<string, unknown>>((resolve) =>
                waiters.push(resolve),
              ));
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "agy", version: "1.5.16" },
                },
              })}\n`,
            );
            await next();
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
            );
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "publish_artifact", arguments: args },
              })}\n`,
            );
            const reply = (await next()) as {
              result: { content: { text: string }[] };
            };
            child.stdin.end();
            await new Promise((resolve) => child.once("exit", resolve));
            return reply.result.content.map((part) => part.text).join("");
          },
        );
        turn.say("published via bridge");
      },
    });
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          {
            ...scripted,
            refusedSessionOptions: antigravityRuntime.refusedSessionOptions,
            manualCompaction: antigravityRuntime.manualCompaction,
          },
        ]),
      }),
    });
    const agent = await w.agent("Agy", { runtime: "antigravity" });
    const project = await w.project();
    await mkdir(join(project.path, "site"), { recursive: true });
    await writeFile(join(project.path, "site", "index.html"), "<h1>agy</h1>");
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    w.client.subscribe("artifacts");
    const sent = await w.send(group.id, "publish the site", {
      mentions: [agent.id],
    });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("published via bridge");

    const artifacts = () =>
      w.client.section<ArtifactView[]>("artifacts", "list") ?? [];
    await until(() => artifacts().length === 1);
    const activity = (done.data as { activity: ToolActivity[] }).activity;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      name: "publish_artifact",
      input: { path: "site", title: "Bridge Page" },
      status: "completed",
      details: {
        artifactId: artifacts()[0]!.id,
        title: "Bridge Page",
        version: 1,
        files: 1,
      },
    });
  });
});

describe("eta's tools, on eta and on Claude Code", () => {
  /** What eta's model is given of a tool, as JSON: what reaches a provider. */
  interface Definition {
    name: string;
    description: string;
    parameters: unknown;
  }

  it("are defined once: the MCP listing is what the eta runtime gives its model, field by field", async () => {
    const etaTools: Definition[] = [];
    const { models } = scriptedModels(() => say("ok"));
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) => {
      if (etaTools.length === 0)
        for (const tool of context.tools ?? [])
          etaTools.push(
            JSON.parse(
              JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }),
            ) as Definition,
          );
      return stream(model, context, options);
    };
    let served: Definition[] = [];
    const w = await world({
      models,
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "claude",
            turn: async (turn) => {
              const server = turn.options.mcpServers?.find(
                (entry) => entry.name === "eta",
              );
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
                  method: "tools/list",
                }),
              });
              const reply = (await response.json()) as {
                result: {
                  tools: {
                    name: string;
                    description?: string;
                    inputSchema: unknown;
                  }[];
                };
              };
              served = reply.result.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                parameters: tool.inputSchema,
              }));
              turn.say("ok");
            },
          }),
        ]),
      }),
    });
    for (const agent of [
      await w.agent("Ada", { model: "fake:model" }),
      await w.agent("Cody", { runtime: "claude", model: "claude:sonnet" }),
    ]) {
      const chat = await alone(w, agent);
      await w.settled(chat, (await w.send(chat, "hello")).replies[0]!.id);
    }

    const byName = new Map(etaTools.map((tool) => [tool.name, tool]));
    // Claude Code is offered only the host's tools; every one of them is one eta's model has too.
    expect(served.length).toBeGreaterThan(0);
    expect(served.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["draft_task", "create_task", "list_tasks"]),
    );
    for (const tool of served) {
      const eta = byName.get(tool.name);
      expect(eta, tool.name).toBeDefined();
      expect(tool.description, tool.name).toBe(eta!.description);
      const ours = eta!.parameters as { properties?: Record<string, unknown> };
      const theirs = tool.parameters as {
        properties?: Record<string, unknown>;
      };
      // Field by field first, so a difference names the parameter; then the whole schema.
      expect(Object.keys(theirs.properties ?? {}), tool.name).toEqual(
        Object.keys(ours.properties ?? {}),
      );
      for (const [field, schema] of Object.entries(ours.properties ?? {}))
        expect(theirs.properties?.[field], `${tool.name}.${field}`).toEqual(
          schema,
        );
      expect(tool.parameters, tool.name).toEqual(eta!.parameters);
    }
    // The parameters #177 found stale on Claude Code are there, on both sides.
    for (const name of ["draft_task", "create_task"]) {
      const properties = Object.keys(
        (
          served.find((tool) => tool.name === name)!.parameters as {
            properties: Record<string, unknown>;
          }
        ).properties,
      );
      expect(properties, name).toEqual(
        expect.arrayContaining(["status", "parent", "dependsOn"]),
      );
    }
  });
});

describe("/compact on an agent on a runtime", () => {
  /** A Claude Code whose compaction is a script too, which scripted sessions have none of. */
  const compacting = (compact: () => Promise<CompactionOutcome>) => {
    const scripted = scriptedRuntime({
      id: "claude",
      turn: (turn) => turn.say("ok"),
    });
    const runtime: Runtime = {
      ...scripted,
      manualCompaction: { kind: "supported", activeTurn: "reject" },
      session: async (installation, options, context) => {
        const session = await scripted.session(installation, options, context);
        return new Proxy(session, {
          get: (target, key) =>
            key === "compact" ? compact : Reflect.get(target, key, target),
        }) as Session;
      },
    };
    return createOarRuntimes({ registry: createRuntimeRegistry([runtime]) });
  };

  it("reaches the runtime on a daemon, and its answer comes back", async () => {
    let asked = 0;
    const runtimes = compacting(async () => {
      asked += 1;
      return { kind: "completed" } as CompactionOutcome;
    });
    const r = await remoteWorld({}, { node: { runtimes } });
    const cody = await r.agent("Cody", {
      runtime: "claude",
      machineId: r.daemon.machineId,
    });
    const group = await r.group(r.remoteProject.id, [cody.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "hi");
    await r.settled(group.id, sent.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    expect(await r.client.call("sessions", "compact", { session })).toEqual({
      session,
      compacted: true,
      runtime: { runtime: "Claude Code", outcome: "completed" },
    });
    expect(asked).toBe(1);
  });
});

describe("a turn Claude Code opens itself, on a background task's notification", () => {
  /**
   * The reply that starts a background subagent ends; when the subagent settles, Claude Code
   * opens a turn of its own on the notification. The scripted runtime's queue does the same from
   * the outside: a queued input on an idle session starts a turn nobody prompted.
   */
  async function onNotifyingClaude(
    notified: (turn: ScriptedTurn) => void | Promise<void>,
  ) {
    const sessions: Session[] = [];
    const scripted = scriptedRuntime({
      id: "claude",
      turn: async (turn) => {
        if (turn.input.startsWith("<task-notification>")) {
          await notified(turn);
          return;
        }
        turn.task({ taskType: "agent", background: true });
        turn.say("The audit is running; I will report when it is back.");
      },
    });
    const runtime: Runtime = {
      ...scripted,
      session: async (installation, options, context) => {
        const session = await scripted.session(installation, options, context);
        sessions.push(session);
        return session;
      },
    };
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([runtime]),
      }),
    });
    const notify = async (text: string) => {
      await sessions
        .at(-1)!
        .queue(`<task-notification>${text}</task-notification>`);
    };
    return { w, notify };
  }

  it("is said in the conversation, and eta's tools answer in it", async () => {
    const results: { text: string; isError: boolean }[] = [];
    const { w, notify } = await onNotifyingClaude(async (turn) => {
      turn.say("The audit is back. ");
      await turn.tool("mcp__eta__publish_artifact", "{}", async () => {
        const result = await callHostTool(turn, "publish_artifact", {
          path: "report",
          title: "Audit",
        });
        results.push(result);
        return result.text;
      });
      turn.say("The report is published.");
    });
    const agent = await w.agent("Opus", {
      runtime: "claude",
      model: "claude:opus",
    });
    const project = await w.project();
    await mkdir(join(project.path, "report"), { recursive: true });
    await writeFile(join(project.path, "report", "index.html"), "<h1>ok</h1>");
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "audit the tests", {
      mentions: [agent.id],
    });
    expect((await w.settled(group.id, sent.replies[0]!.id)).status).toBe(
      "done",
    );

    await notify("audit completed");
    const said = () =>
      w
        .rows(group.id)
        .find(
          (row) =>
            row.author === "agent" &&
            row.id !== sent.replies[0]!.id &&
            row.status === "done",
        );
    await until(() => said() !== undefined);
    expect(said()).toMatchObject({
      agentId: agent.id,
      text: "The report is published.",
      data: expect.objectContaining({ unprompted: true }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]!.text).toMatch(
      /^Published "Audit" as artifact \S+, version 1 /,
    );
  });

  it("lets a steer from the user join it while it runs", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let current: ScriptedTurn | undefined;
    const { w, notify } = await onNotifyingClaude(async (turn) => {
      current = turn;
      turn.say("Reading the results");
      await held;
      turn.say(" and yes: here they are.");
    });
    const agent = await w.agent("Opus", { runtime: "claude" });
    const chat = await alone(w, agent);
    await w.settled(chat, (await w.send(chat, "audit")).replies[0]!.id);
    await notify("audit completed");
    const working = () =>
      w
        .rows(chat)
        .find((row) => row.author === "agent" && row.status === "working");
    await until(() => working() !== undefined);
    const asked = await w.send(chat, "is there a report yet?", {
      mode: "steer",
    });
    // Joined the turn in flight: no reply of its own.
    expect(asked.replies).toEqual([]);
    // It reaches the runtime's turn while that turn is still going.
    await until(() => (current?.steered.length ?? 0) > 0);
    expect(current!.steered.join("")).toContain("is there a report yet?");
    release();
    await until(() => working() === undefined);
    expect(
      w.rows(chat).filter((row) => row.data.unprompted === true),
    ).toMatchObject([
      { status: "done", text: "Reading the results and yes: here they are." },
    ]);
  });

  it("holds a queued message until it ends, then answers it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { w, notify } = await onNotifyingClaude(async (turn) => {
      turn.say("Here are the results.");
      await held;
    });
    const agent = await w.agent("Opus", { runtime: "claude" });
    const chat = await alone(w, agent);
    await w.settled(chat, (await w.send(chat, "audit")).replies[0]!.id);
    await notify("audit completed");
    await until(() => w.rows(chat).some((row) => row.data.unprompted === true));
    const asked = await w.send(chat, "is there a report yet?");
    expect(asked.replies).toHaveLength(1);
    release();
    const answered = await w.settled(chat, asked.replies[0]!.id);
    expect(answered).toMatchObject({
      status: "done",
      text: "The audit is running; I will report when it is back.",
    });
    expect(
      w.rows(chat).filter((row) => row.data.unprompted === true),
    ).toMatchObject([{ status: "done", text: "Here are the results." }]);
  });

  it("writes no row for a turn of its own that says nothing", async () => {
    // Two notifications close together: Claude Code can answer both in the second turn.
    const { w, notify } = await onNotifyingClaude((turn) => {
      if (turn.input.includes("second")) turn.say("Both batches are done.");
    });
    const agent = await w.agent("Opus", { runtime: "claude" });
    const chat = await alone(w, agent);
    await w.settled(chat, (await w.send(chat, "audit")).replies[0]!.id);
    await notify("first");
    await notify("second");
    const unprompted = () =>
      w.rows(chat).filter((row) => row.data.unprompted === true);
    await until(
      () =>
        unprompted().length > 0 &&
        unprompted().every((row) => row.status === "done"),
    );
    expect(unprompted()).toMatchObject([
      { status: "done", text: "Both batches are done." },
    ]);
  });
});
