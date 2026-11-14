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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { scriptedModels } from "./support/models";
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

async function direct(w: World, agent: AgentView) {
  const { conversation } = (await w.client.call("agents", "direct", {
    agentId: agent.id,
  })) as { conversation: { id: string } };
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
    const chat = await direct(w, agent);
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
    const chat = await direct(w, agent);
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
    const chat = await direct(w, agent);
    await w
      .settled(chat, (await w.send(chat, "one")).replies[0]!.id)
      .catch(() => undefined);
    await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
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
    const project = await w.project({ stewardId: agent.id });
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
    const project = await w.project({ stewardId: agent.id });
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
    const project = await w.project({ stewardId: agent.id });
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
    const cody = await r.agent("Cody", { runtime: "claude" });
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
    const project = await w.project({ stewardId: agent.id });
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
    expect(results[0]!.text).toContain('Published "Audit" version 1');
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
    const chat = await direct(w, agent);
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
    const chat = await direct(w, agent);
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
    const chat = await direct(w, agent);
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
