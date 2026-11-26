/**
 * An eta session on an external runtime, end to end, with oar's scripted runtime standing in for
 * Claude Code: no binary, no login, the same `Session` semantics.
 *
 * What these pin: the runtime's turn lands in the session's journal as eta turns (assistant
 * message, tool call, tool result), the model the session is on is the one the runtime is opened
 * with, a model change resumes the same runtime conversation, steering reaches the turn in flight
 * and what does not reach it is kept, `/compact` is the runtime's and says what became of it, an
 * abort is an abort, and a reopened session picks its runtime conversation back up.
 */
import type {
  CompactionOptions,
  CompactionOutcome,
  Event,
  EventObserver,
  InputOptions,
  ManualCompaction,
  Runtime,
  Session,
} from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { Served } from "@eta/runtime-kit/testing";
import type { ManagedSession, SessionManagerOptions } from "@eta/server";
import type { RuntimeId } from "../src/index";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { kernelEmit, kernelOn } from "@eta/core";
import { listenServed, listServed } from "@eta/runtime-kit/testing";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { describe, expect, it } from "vitest";
import { createOarRuntimes } from "../src/index";

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `[${block.name}]`
              : "",
        )
        .join("")
    : "";

/** A session with members replaced: what a scripted one cannot be made to do. */
function patched(session: Session, members: Partial<Session>): Session {
  return new Proxy(session, {
    get: (target, key) =>
      key in members
        ? members[key as keyof Session]
        : Reflect.get(target, key, target),
  });
}

/** How a runtime answers a control it turned down, as much of it as the delegate reads. */
const rejection = (reason: string) =>
  ({ kind: "rejected", code: "no_active_turn", reason }) as never;
const acceptance = { kind: "accepted" } as never;

const tick = async (ms = 20) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

function setup(
  turn: (turn: ScriptedTurn) => void | Promise<void>,
  options: Partial<SessionManagerOptions> & {
    runtimeId?: RuntimeId;
    refuses?: boolean;
    /** Replaces members of every session the runtime opens. */
    patch?: (session: Session) => Partial<Session>;
    manualCompaction?: ManualCompaction;
    listModels?: Runtime["listModels"];
  } = {},
) {
  const {
    runtimeId = "claude",
    refuses = false,
    patch,
    manualCompaction,
    listModels,
    ...managerOptions
  } = options;
  const turns: ScriptedTurn[] = [];
  const opened: {
    options: Parameters<Runtime["session"]>[1];
    session: Session;
  }[] = [];
  const scripted = scriptedRuntime({
    id: runtimeId,
    turn: async (scriptedTurn) => {
      turns.push(scriptedTurn);
      await turn(scriptedTurn);
    },
  });
  const runtime: Runtime = {
    ...scripted,
    session: async (installation, sessionOptions, context) => {
      // The scripted runtime lists no effort levels of its own and refuses any effort: with a
      // stand-in list, what eta asked for is recorded below and the script runs without it.
      const { effort: _effort, ...withoutEffort } = sessionOptions;
      const session = await scripted.session(
        installation,
        listModels === undefined ? sessionOptions : withoutEffort,
        context,
      );
      const seen =
        patch === undefined ? session : patched(session, patch(session));
      opened.push({ options: sessionOptions, session: seen });
      return seen;
    },
    ...(refuses
      ? { refusedSessionOptions: { appendSystemPrompt: "not on this one" } }
      : {}),
    ...(manualCompaction === undefined ? {} : { manualCompaction }),
    ...(listModels === undefined ? {} : { listModels }),
  };
  const warnings: string[] = [];
  const runtimes = createOarRuntimes({
    registry: createRuntimeRegistry([runtime]),
    warn: (message) => warnings.push(message),
  });
  const store = new MemorySessionStore();
  const manager = new SessionManager({
    store,
    modelsFor: () => {
      throw new Error("an eta model was asked for");
    },
    runtimes,
    agentPromptFor: () => "In this conversation you are Probe.",
    ...managerOptions,
  });
  return { manager, turns, store, opened, warnings };
}

async function run(managed: ManagedSession, prompt: string) {
  const { kernel, runner } = managed.session;
  kernel.nextRun(prompt);
  return await runner.run();
}

const hostTool = (name: string): KernelTool =>
  ({
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: [{ type: "text", text: "done" }] }),
  }) as KernelTool;

const platformFor = (meta: { id: string; cwd: string }) => ({
  cwd: meta.cwd,
  home: "/home/lemon",
  configPath: "/home/lemon/.eta/config.json",
  sessionDir: `/home/lemon/.eta/sessions/${meta.id}`,
  memoryTarget: `${meta.cwd}/.eta/MEMORY.md`,
  memoryExists: false,
});

/** The tools a member of a conversation and the executor of a task are given. */
const MEMBER_TOOLS = [
  "draft_task",
  "create_task",
  "update_task",
  "comment_task",
];
const EXECUTOR_TOOLS = ["update_task", "comment_task", "finish_task"];

/** Names an eta session's tools, or a memory, that a runtime does not have. */
const NOT_ON_A_RUNTIME = [
  "create_step",
  "list_steps",
  "get_step",
  "update_step",
  "memory block",
  "MEMORY.md",
  "persona",
];

const expectNoneOf = (text: string) => {
  // `meta.json`'s own description names the persona field; that is the file, not a card.
  const said = text.replace("(persona, cwd, title, model)", "");
  for (const name of NOT_ON_A_RUNTIME) expect(said).not.toContain(name);
};

const transcript = (managed: ManagedSession): string[] =>
  managed.session.journaling
    .transcript()
    .map((message) => `${message.role}:${textOf(message)}`);

describe("what an external runtime is told about the app", () => {
  it("appends the board's rules and the app's paths to the runtime's system prompt", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt.startsWith("In this conversation you are Probe.")).toBe(true);
    expect(prompt).toContain("<platform>");
    expect(prompt).toContain("Propose it with `draft_task`");
    expect(prompt).toContain("/home/lemon/.eta/config.json");
    expect(prompt).toContain(`/home/lemon/.eta/sessions/${managed.meta.id}`);
    expectNoneOf(prompt);
    expect(prompt).not.toContain("finish_task");
    await manager.closeAll();
  });

  it("puts them in the first prompt of a runtime that refuses a system prompt", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
      refuses: true,
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    await run(managed, "and another");
    expect(turns[0]!.options.appendSystemPrompt).toBeUndefined();
    expect(turns[0]!.input).toContain("Propose it with `draft_task`");
    expect(turns[0]!.input).toContain("/home/lemon/.eta/config.json");
    expect(turns[0]!.input.endsWith("change a line")).toBe(true);
    expectNoneOf(turns[0]!.input);
    expect(turns[1]!.input).toBe("and another");
    await manager.closeAll();
  });

  it("does not send the executor of a task off to draft it", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => EXECUTOR_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "do the task");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt).toContain("/home/lemon/.eta/config.json");
    expect(prompt).toContain("This session is one of those");
    expect(prompt).not.toContain("draft_task");
    expect(prompt).not.toContain("create_task");
    expectNoneOf(prompt);
    await manager.closeAll();
  });

  it("tells the rules without the paths on a host that has no platform facts", async () => {
    // A daemon: it has the tools, and the app's config is on the primary.
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt).toContain("Propose it with `draft_task`");
    expect(prompt).not.toContain("readable");
    await manager.closeAll();
  });

  it("is told again on resume: a resumed conversation that is not forgets at its next compaction", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "after");
    expect(turns[0]!.options.appendSystemPrompt).toContain("draft_task");
    expect(turns[1]!.options.resume).toBeDefined();
    expect(turns[1]!.options.appendSystemPrompt).toContain("draft_task");
    await manager.closeAll();
  });
});

const SUPPORTED: ManualCompaction = { kind: "supported", activeTurn: "reject" };

/** What the delegate reads of a compaction's outcome; the records around it are oar's. */
const outcome = (fields: object) => fields as CompactionOutcome;

describe("compacting an external runtime's context", () => {
  const compacting = (
    compact: (options?: CompactionOptions) => Promise<CompactionOutcome>,
    options: Parameters<typeof setup>[1] = {},
  ) =>
    setup((turn) => turn.say("ok"), {
      manualCompaction: SUPPORTED,
      patch: () => ({ compact }),
      ...options,
    });

  it.each([
    [{ kind: "completed" }, { outcome: "completed" }],
    [{ kind: "aborted" }, { outcome: "aborted" }],
    [
      {
        kind: "rejected",
        code: "busy",
        reason: "Wait until the session is idle",
      },
      { outcome: "busy" },
    ],
    [
      { kind: "rejected", code: "aborted", reason: "not sent" },
      { outcome: "aborted" },
    ],
    [
      {
        kind: "rejected",
        code: "unsupported",
        reason: "a project has its own /compact",
      },
      { outcome: "failed", reason: "a project has its own /compact" },
    ],
    [
      { kind: "failed", code: "not_compacted", reason: "no boundary" },
      { outcome: "failed", reason: "no boundary" },
    ],
    [
      { kind: "unconfirmed", code: "timeout", reason: "stopped waiting" },
      { outcome: "unconfirmed", reason: "stopped waiting" },
    ],
  ])("tells %j as %j", async (said, told) => {
    const { manager } = compacting(async () => outcome(said));
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "start");
    expect(await manager.compactRuntime(managed)).toEqual({
      runtime: "Claude Code",
      ...told,
    });
    await manager.closeAll();
  });

  it("says a turn is running without asking the runtime", async () => {
    let asked = 0;
    const { manager } = setup(
      async (turn) =>
        await new Promise<void>((resolve) =>
          turn.signal.addEventListener("abort", () => resolve()),
        ),
      {
        manualCompaction: SUPPORTED,
        patch: () => ({
          compact: async () => {
            asked += 1;
            return outcome({ kind: "completed" });
          },
        }),
      },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    expect((await manager.compactRuntime(managed)).outcome).toBe("busy");
    expect(asked).toBe(0);
    managed.session.runner.abort();
    await running;
    await manager.closeAll();
  });

  it("names the runtime that has no compaction, a turn running or not", async () => {
    const { manager, turns } = setup(async (turn) => {
      if (turns.length === 1) await tick(40);
      turn.say("ok");
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    expect(await manager.compactRuntime(managed)).toEqual({
      runtime: "Claude Code",
      outcome: "unsupported",
    });
    await running;
    expect((await manager.compactRuntime(managed)).outcome).toBe("unsupported");
    await manager.closeAll();
  });

  it("takes a runtime's word that it cannot, before opening anything", async () => {
    const { manager, opened } = setup((turn) => turn.say("ok"), {
      manualCompaction: { kind: "unsupported", reason: "no such thing" },
    });
    // A session with a runtime session to resume: without the declaration,
    // compacting it would resume that session first.
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    const before = opened.length;
    expect((await manager.compactRuntime(reopened)).outcome).toBe(
      "unsupported",
    );
    expect(opened).toHaveLength(before);
    await manager.closeAll();
  });

  it("has nothing to compact before the first run", async () => {
    const { manager, opened } = compacting(async () =>
      outcome({ kind: "completed" }),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    expect((await manager.compactRuntime(managed)).outcome).toBe("empty");
    expect(opened).toHaveLength(0);
    await manager.closeAll();
  });

  it("resumes a session not open yet, tells it who it is, and lets it go", async () => {
    const { manager, opened, turns } = compacting(
      async () => outcome({ kind: "completed" }),
      {
        platformFor,
        sessionTools: () => MEMBER_TOOLS.map(hostTool),
      },
    );
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    created.session.kernel.config.update({
      model: { provider: "claude", modelId: "sonnet" },
    });
    await run(created, "before");
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    reopened.session.kernel.config.update({
      model: { provider: "claude", modelId: "sonnet" },
    });

    expect((await manager.compactRuntime(reopened)).outcome).toBe("completed");
    const forCompaction = opened.at(-1)!;
    expect(forCompaction.options.resume).toBe(created.meta.runtimeSession);
    expect(forCompaction.options.model).toBe("sonnet");
    expect(forCompaction.options.appendSystemPrompt).toContain("draft_task");
    expect(forCompaction.options.mcpServers).toBeUndefined();
    expect(forCompaction.session.status().value.kind).toBe("idle");
    expect(
      forCompaction.session
        .records()
        .some(
          (record) =>
            record.kind === "request" && record.body.kind === "dispose",
        ),
    ).toBe(true);

    // The next run opens the conversation for real, with the host's tools.
    await run(reopened, "after");
    expect(turns.at(-1)!.options.resume).toBe(created.meta.runtimeSession);
    expect(turns.at(-1)!.options.mcpServers).toHaveLength(1);
    await manager.closeAll();
  });

  it("has nothing to compact when the conversation is gone", async () => {
    const { manager } = compacting(async () => {
      throw Object.assign(new Error("gone"), { name: "SessionNotFoundError" });
    });
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    expect((await manager.compactRuntime(created)).outcome).toBe("empty");
    await manager.closeAll();
  });

  it("tells a runtime that will not open as a failure", async () => {
    const { manager } = compacting(async () => {
      throw new Error("the pipe broke");
    });
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    expect(await manager.compactRuntime(created)).toEqual({
      runtime: "Claude Code",
      outcome: "failed",
      reason: "the pipe broke",
    });
    await manager.closeAll();
  });

  it("holds a run back until the compaction is over", async () => {
    let finish!: (value: CompactionOutcome) => void;
    const { manager, turns } = compacting(
      async () =>
        await new Promise<CompactionOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "before");
    const compaction = manager.compactRuntime(managed);
    await tick();
    const running = run(managed, "after");
    await tick();
    expect(turns).toHaveLength(1);
    finish(outcome({ kind: "completed" }));
    expect((await compaction).outcome).toBe("completed");
    expect((await running).status).toBe("completed");
    expect(turns.map((turn) => turn.input)).toEqual(["before", "after"]);
    await manager.closeAll();
  });

  it("lets a run be stopped while it waits for a compaction", async () => {
    let finish!: (value: CompactionOutcome) => void;
    const { manager, turns } = compacting(
      async () =>
        await new Promise<CompactionOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "before");
    const compaction = manager.compactRuntime(managed);
    await tick();
    const running = run(managed, "after");
    await tick();
    managed.session.runner.abort();
    expect((await running).status).toBe("aborted");
    expect(turns).toHaveLength(1);
    finish(outcome({ kind: "completed" }));
    await compaction;
    await manager.closeAll();
  });

  it("answers a second /compact with the one in flight", async () => {
    let asked = 0;
    let finish!: (value: CompactionOutcome) => void;
    const { manager } = compacting(async () => {
      asked += 1;
      return await new Promise<CompactionOutcome>((resolve) => {
        finish = resolve;
      });
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "before");
    const first = manager.compactRuntime(managed);
    await tick();
    const second = manager.compactRuntime(managed);
    finish(outcome({ kind: "completed" }));
    expect((await first).outcome).toBe("completed");
    expect((await second).outcome).toBe("completed");
    expect(asked).toBe(1);
    await manager.closeAll();
  });

  it("stops waiting for a compaction when the session closes", async () => {
    const { manager } = compacting(
      async ({ signal } = {}) =>
        await new Promise<CompactionOutcome>((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve(
              outcome({
                kind: "unconfirmed",
                code: "signal",
                reason: "stopped",
              }),
            ),
          );
        }),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "before");
    const compaction = manager.compactRuntime(managed);
    await tick();
    await manager.close(managed.meta.id);
    expect((await compaction).outcome).toBe("unconfirmed");
  });
});

describe("a session on an external runtime", () => {
  it("journals the runtime's turn as eta turns", async () => {
    const { manager, turns } = setup(async (turn) => {
      turn.say("Looking.");
      await turn.tool("Bash", '{"command":"ls"}', () => "a.txt");
      turn.say("Done.");
    });
    const managed = await manager.create({
      cwd: "/work",
      runtime: "claude",
      model: "claude:sonnet",
    });
    const tools: string[] = [];
    kernelOn(managed.session.kernel.ctx)("tool:end", ({ toolName, isError }) =>
      tools.push(`${toolName}:${isError}`),
    );
    const result = await run(managed, "list the files");
    expect(result.status).toBe("completed");
    expect(transcript(managed)).toEqual([
      "user:list the files",
      "assistant:Looking.[Bash]",
      "toolResult:a.txt",
      "assistant:Done.",
    ]);
    expect(tools).toEqual(["Bash:false"]);
    expect(turns[0]!.options.model).toBe("sonnet");
    expect(turns[0]!.options.appendSystemPrompt).toBe(
      "In this conversation you are Probe.",
    );
    const meta = (await manager.list()).find(
      (row) => row.id === managed.meta.id,
    );
    expect(meta?.ok && meta.meta.runtimeSession).toBeTruthy();
    await manager.closeAll();
  });

  it("opens the runtime with `ultra` where the model lists it, and with nothing where it does not", async () => {
    const { manager, opened } = setup((turn) => turn.say("ok"), {
      listModels: async () => ({
        kind: "ok",
        models: [
          {
            id: "astra",
            effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
          },
          { id: "sol", effortLevels: ["low", "medium", "high"] },
        ],
      }),
    });
    const managed = await manager.create({
      cwd: "/work",
      runtime: "claude",
      model: "claude:astra",
    });
    const config = managed.session.kernel.config;
    const effortOf = () =>
      (
        managed.session.journaling.transcript().at(-1) as {
          effort?: unknown;
        }
      ).effort;
    config.update({ thinkingLevel: "ultra", thinkingAsked: "ultra" });
    // The first run is what asks the runtime for its models: until then its levels are unknown,
    // and the level goes as it was chosen.
    expect((await run(managed, "first")).status).toBe("completed");
    expect(opened.at(-1)!.options.effort).toBe("ultra");
    expect(effortOf()).toEqual({ asked: "ultra", sent: "ultra" });
    // Known now, and listed: still `ultra`.
    expect((await run(managed, "think hard")).status).toBe("completed");
    expect(opened.at(-1)!.options.effort).toBe("ultra");
    expect(effortOf()).toEqual({ asked: "ultra", sent: "ultra" });

    // A model that does not list it: nothing is passed (never `max`), the runtime's default runs.
    config.update({ model: { provider: "claude", modelId: "sol" } });
    expect((await run(managed, "again")).status).toBe("completed");
    expect(opened.at(-1)!.options.model).toBe("sol");
    expect(opened.at(-1)!.options).not.toHaveProperty("effort");
    expect(effortOf()).toEqual({ asked: "ultra", sent: null });
    await manager.closeAll();
  });

  it("resumes the same runtime conversation on a new model", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"));
    const managed = await manager.create({
      cwd: "/work",
      runtime: "claude",
      model: "claude:sonnet",
    });
    await run(managed, "one");
    managed.session.kernel.config.update({
      model: { provider: "claude", modelId: "opus" },
    });
    await run(managed, "two");
    expect(turns.map((turn) => turn.options.model)).toEqual(["sonnet", "opus"]);
    expect(turns[1]!.options.resume).toBe(managed.meta.runtimeSession);
    // Told on every open: a resumed conversation that is not forgets at its next compaction.
    expect(turns[0]!.options.appendSystemPrompt).toBeDefined();
    expect(turns[1]!.options.appendSystemPrompt).toBeDefined();
    expect(transcript(managed)).toEqual([
      "user:one",
      "assistant:ok",
      "user:two",
      "assistant:ok",
    ]);
    await manager.closeAll();
  });

  it("steers the turn in flight", async () => {
    let steered: readonly string[] = [];
    const { manager } = setup(async (turn) => {
      for (let i = 0; i < 100 && turn.steered.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      steered = turn.steered;
      turn.say("heard");
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    managed.session.kernel.steer("and this");
    expect((await running).status).toBe("completed");
    expect(steered).toEqual(["and this"]);
    expect(transcript(managed)).toEqual([
      "user:start",
      "user:and this",
      "assistant:heard",
    ]);
    await manager.closeAll();
  });

  it("keeps a steer the runtime turned down for the next prompt", async () => {
    const steers: string[] = [];
    const { manager, turns, warnings } = setup(
      async (turn) => {
        for (
          let i = 0;
          i < 100 && steers.length === 0 && turns.length === 1;
          i++
        )
          await tick(10);
        turn.say("heard");
      },
      {
        patch: () => ({
          steer: async (input) => {
            steers.push(input);
            return rejection("not_steerable: no active turn");
          },
        }),
      },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(50);
    managed.session.kernel.steer("and this");
    expect((await running).status).toBe("completed");
    expect(steers).toEqual(["and this"]);
    expect(turns.map((turn) => turn.input)).toEqual(["start", "and this"]);
    expect(warnings.join()).toContain("no active turn");
    await manager.closeAll();
  });

  it("keeps a steer whose refusal comes after the turn has ended", async () => {
    const steering = Promise.withResolvers<void>();
    let endedFirst = false;
    const { manager, turns } = setup(
      async (turn) => {
        if (turns.length === 1) await steering.promise;
        turn.say("heard");
      },
      {
        patch: (session) => ({
          steer: async () => {
            steering.resolve();
            await tick(40);
            endedFirst = session.status().value.kind === "idle";
            return rejection("not_steerable: no active turn");
          },
        }),
      },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(20);
    managed.session.kernel.steer("late");
    expect((await running).status).toBe("completed");
    expect(endedFirst).toBe(true);
    expect(turns.map((turn) => turn.input)).toEqual(["start", "late"]);
    await manager.closeAll();
  });

  it("keeps a steer whose delivery throws", async () => {
    const { manager, turns } = setup(
      async (turn) => {
        if (turns.length === 1) await tick(60);
        turn.say("heard");
      },
      {
        patch: () => ({
          steer: async () => {
            throw new Error("the pipe broke");
          },
        }),
      },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(20);
    managed.session.kernel.steer("and this");
    expect((await running).status).toBe("completed");
    expect(turns.map((turn) => turn.input)).toEqual(["start", "and this"]);
    await manager.closeAll();
  });

  it("keeps steers in the order they came, once one has come back", async () => {
    const { manager, turns } = setup(
      async (turn) => {
        if (turns.length === 1) await tick(60);
        turn.say("heard");
      },
      { patch: () => ({ steer: async () => rejection("no") }) },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(20);
    managed.session.kernel.steer("first");
    await tick(5);
    managed.session.kernel.steer("second");
    expect((await running).status).toBe("completed");
    expect(turns[1]!.input).toBe("first\n\nsecond");
    await manager.closeAll();
  });

  it("carries a steer that had no turn left to the next run", async () => {
    const { manager, turns } = setup(
      async (turn) => {
        if (turns.length === 1)
          await new Promise<void>((resolve) =>
            turn.signal.addEventListener("abort", () => resolve()),
          );
        turn.say("ok");
      },
      { patch: () => ({ steer: async () => rejection("no") }) },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(20);
    managed.session.kernel.steer("and this");
    await tick(20);
    managed.session.runner.abort();
    expect((await running).status).toBe("aborted");
    expect((await run(managed, "next")).status).toBe("completed");
    expect(turns[1]!.input).toBe("and this\n\nnext");
    await manager.closeAll();
  });

  const image = {
    type: "image" as const,
    data: "aGVsbG8=",
    mimeType: "image/png",
  };

  /** Steers as the runtime got them, passed on to the scripted runtime. */
  const recordingSteers = () => {
    const steers: { input: string; options: InputOptions | undefined }[] = [];
    const patch = (session: Session) => ({
      steer: async (input: string, options?: InputOptions) => {
        steers.push({ input, options });
        return await session.steer!(input, options);
      },
    });
    return { steers, patch };
  };

  it("steers images into the turn in flight", async () => {
    const { steers, patch } = recordingSteers();
    const { manager } = setup(
      async (turn) => {
        for (let i = 0; i < 100 && turn.steered.length === 0; i++)
          await tick(10);
        turn.say("heard");
      },
      { patch },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(50);
    managed.session.kernel.steer("look", [image]);
    expect((await running).status).toBe("completed");
    expect(steers.map((steer) => steer.input)).toEqual(["look"]);
    const [delivered] = steers[0]!.options?.images ?? [];
    expect(delivered?.mediaType).toBe("image/png");
    expect(readFileSync(delivered!.path)).toEqual(
      Buffer.from(image.data, "base64"),
    );
    await manager.closeAll();
  });

  it("steers images with no words at all", async () => {
    const { steers, patch } = recordingSteers();
    const { manager, turns } = setup(
      async (turn) => {
        for (let i = 0; i < 100 && turn.steered.length === 0; i++)
          await tick(10);
        turn.say("heard");
      },
      { patch },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(50);
    managed.session.kernel.steer("", [image]);
    expect((await running).status).toBe("completed");
    expect(steers.map((steer) => steer.input)).toEqual([""]);
    expect(steers[0]!.options?.images).toHaveLength(1);
    expect(turns).toHaveLength(1);
    await manager.closeAll();
  });

  it("keeps a steer's images when the runtime turns it down", async () => {
    const { manager, turns } = setup(
      async (turn) => {
        if (turns.length === 1) await tick(60);
        turn.say("heard");
      },
      { patch: () => ({ steer: async () => rejection("no") }) },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(20);
    managed.session.kernel.steer("", [image]);
    expect((await running).status).toBe("completed");
    expect(turns[1]!.input).toBe("");
    expect(turns[1]!.images).toHaveLength(1);
    await manager.closeAll();
  });

  it("names images by path to a runtime that takes none", async () => {
    const { steers, patch } = recordingSteers();
    const { manager, turns } = setup(
      async (turn) => {
        for (let i = 0; i < 100 && turn.steered.length === 0; i++)
          await tick(10);
        turn.say("heard");
      },
      {
        patch: (session) => ({
          ...patch(session),
          capabilities: { ...session.capabilities, images: false },
        }),
      },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    managed.session.kernel.nextRun("start", [image]);
    const running = managed.session.runner.run();
    await tick(50);
    managed.session.kernel.steer("look", [image]);
    expect((await running).status).toBe("completed");
    expect(turns[0]!.images).toEqual([]);
    expect(turns[0]!.input).toMatch(/^start\n\n\[image: .+\.png\]$/);
    expect(steers[0]!.input).toMatch(/^look\n\n\[image: .+\.png\]$/);
    expect(steers[0]!.options?.images).toBeUndefined();
    await manager.closeAll();
  });

  /**
   * A session whose frames the test writes: what oar reports of a real runtime in the moments a
   * scripted one has no way to reach. The shapes are from Claude Code 2.1.314.
   */
  const handDriven = () => {
    const observers = new Set<EventObserver>();
    const prompts: { input: string; id: string }[] = [];
    const steers: { input: string; id: string }[] = [];
    let native = "";
    let sequence = 0;
    const say = (event: Record<string, unknown>) => {
      const envelope = {
        sessionId: native,
        seq: ++sequence,
        receivedAt: Date.now(),
        agentPath: [],
      };
      for (const observer of observers)
        observer({ ...envelope, ...event } as unknown as Event);
    };
    const patch = (session: Session): Partial<Session> => {
      native = session.id;
      return {
        events: (observer) => {
          observers.add(observer);
          return () => observers.delete(observer);
        },
        prompt: async (input, options) => {
          prompts.push({ input, id: options?.inputId ?? "" });
          return acceptance;
        },
        steer: async (input, options) => {
          steers.push({ input, id: options?.inputId ?? "" });
          return acceptance;
        },
      };
    };
    return { prompts, steers, say, patch };
  };

  it("publishes an OAR root context without a billing report and invalidates it on a native model change", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const member = await manager.create({ cwd: "/work", runtime: "claude" });
    try {
      const running = run(member, "context");
      await expect.poll(() => prompts.length).toBe(1);
      say({
        kind: "usage",
        usage: {
          context: { tokens: 64000, contextWindow: 128000, percent: 50 },
        },
      });
      const view = () => member.session.view.snapshot().sections;
      expect(view().context).toMatchObject({
        source: "oar",
        used: 64000,
        window: 128000,
        reason: null,
      });
      say({
        kind: "usage",
        usage: {
          context: { tokens: 64000, contextWindow: 128000, percent: 99 },
        },
      });
      expect(view().context).toMatchObject({ reason: "inconsistent" });
      say({ kind: "turn_ended", outcome: { kind: "completed" } });
      await running;
      say({ kind: "model", model: "new-model" });
      expect(view().context).toMatchObject({
        model: "claude:new-model",
        reason: "model",
        used: null,
      });
      expect(view().spend).toEqual({ input: null, output: null, cache: null });
    } finally {
      await manager.closeAll();
    }
  });

  it.each(["opencode", "antigravity", "grok", "qwen"] as const)(
    "publishes a root context pair from %s through the shared OAR channel",
    async (runtimeId) => {
      const { prompts, say, patch } = handDriven();
      const { manager } = setup(() => undefined, { patch, runtimeId });
      const member = await manager.create({ cwd: "/work", runtime: runtimeId });
      try {
        const running = run(member, "context");
        await expect.poll(() => prompts.length).toBe(1);
        say({ kind: "turn_active" });
        say({
          kind: "usage",
          usage: {
            context: {
              tokens: 19_010,
              contextWindow: 128_000,
              percent: null,
            },
          },
        });
        say({ kind: "turn_ended", outcome: { kind: "completed" } });
        await running;
        expect(member.session.view.snapshot().sections.context).toMatchObject({
          source: "oar",
          used: 19_010,
          window: 128_000,
          observation: "last-observed",
        });
      } finally {
        await manager.closeAll();
      }
    },
  );

  it("keeps Codex last-call occupancy apart from cumulative input and rejects stale or child samples", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch, runtimeId: "codex" });
    const member = await manager.create({
      cwd: "/work",
      runtime: "codex",
      model: "codex:first",
    });
    const other = await manager.create({ cwd: "/work", runtime: "codex" });
    const view = () => member.session.view.snapshot().sections;
    try {
      const running = run(member, "context");
      await expect.poll(() => prompts.length).toBe(1);
      say({ kind: "turn_active", spanId: "native-turn" });
      say({ kind: "text_delta", text: "ok" });
      const sample = (
        used: number | null,
        window: number | null,
        envelope: Record<string, unknown> = {},
      ) =>
        say({
          kind: "usage",
          spanId: "native-turn",
          usage: {
            context: { tokens: used, contextWindow: window, percent: null },
            tokens: { input: 240000, output: 0 },
          },
          ...envelope,
        });
      // Feed a synthetic thread/tokenUsage/updated through the installed Codex adapter.
      // This also pins the sentinel OAR emits for older Codex builds without last.
      const decoder = new URL(
        "./token-usage.js",
        import.meta.resolve("@botiverse/oar/runtimes/codex"),
      );
      const { codexUsageViews } = await import(decoder.href);
      const report = (last?: number) => {
        const tokenUsage = {
          total: { inputTokens: 240000, outputTokens: 0 },
          ...(last === undefined ? {} : { last: { totalTokens: last } }),
          modelContextWindow: 128000,
        };
        for (const event of codexUsageViews(
          { tokenUsage },
          { input: 0, output: 0 },
        ))
          say({ ...event, spanId: "native-turn" });
      };
      report();
      expect(view().context).toMatchObject({ reason: "codexLast" });
      sample(0, 128000);
      expect(view().context).toMatchObject({ used: 0, reason: null });
      sample(128000, 128000);
      expect(view().context).toMatchObject({ used: 128000, reason: null });
      sample(152081, 128000);
      expect(view().context).toMatchObject({ reason: "inconsistent" });
      sample(42, 0);
      expect(view().context).toMatchObject({ reason: "window" });
      report(32000);
      sample(123, 128000, { agentPath: ["child"] });
      sample(124, 128000, { sessionId: "another-thread" });
      sample(125, 128000, { spanId: "an-old-turn" });
      expect(view().context).toMatchObject({
        source: "codex-last",
        used: 32000,
        window: 128000,
        reason: null,
      });
      const { runId, observedAt } = view().context as {
        runId: string;
        observedAt: number;
      };
      say({ kind: "compaction_started" });
      expect(view().context).toMatchObject({
        reason: "compacted",
        compactedAt: null,
      });
      say({ kind: "compaction_ended", outcome: "completed" });
      expect(view().context).toMatchObject({ compactedAt: expect.any(Number) });
      kernelEmit(member.session.kernel.ctx)("context:observed", {
        runId,
        nativeSessionId: "late-thread",
        model: "first",
        observedAt: observedAt - 1,
        used: 128000,
        window: 128000,
      });
      expect(view().context).toMatchObject({ reason: "compacted", used: null });
      sample(null, 128000);
      expect(view().context).toMatchObject({ reason: "compacted" });
      say({ kind: "turn_ended", outcome: { kind: "completed" } });
      await running;
      expect(view().spend).toMatchObject({
        input: { value: 240000, coverage: "complete" },
        output: { value: 0, coverage: "complete" },
        cache: null,
      });
      member.session.kernel.config.update({
        model: { provider: "codex", modelId: "second" },
      });
      kernelEmit(member.session.kernel.ctx)("context:observed", {
        runId,
        nativeSessionId: "late-thread",
        model: "first",
        observedAt: Date.now(),
        used: 128000,
        window: 128000,
      });
      expect(view().context).toMatchObject({
        model: "codex:second",
        used: null,
        reason: "model",
      });
      expect(other.session.view.snapshot().sections.context).toMatchObject({
        session: other.meta.id,
        reason: "missing",
      });
    } finally {
      await manager.closeAll();
    }
  });

  it("lasts through the turn a steer taken too late opens of its own", async () => {
    const { prompts, steers, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    let settled = false;
    const running = run(managed, "start").finally(() => {
      settled = true;
    });
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    expect(steers).toHaveLength(1);
    // The turn ended without it: claude reads the steer next, and answers it in a turn of its own.
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [prompts[0]!.id],
    });
    await tick();
    expect(settled).toBe(false);
    say({ kind: "text_delta", text: "heard it" });
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [steers[0]!.id],
    });
    expect((await running).status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(transcript(managed)).toEqual([
      "user:start",
      "user:and this",
      "assistant:heard it",
    ]);
    await manager.closeAll();
  });

  it("ends with the turn when a steer was merged into it", async () => {
    const { prompts, steers, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [prompts[0]!.id, steers[0]!.id],
    });
    expect((await running).status).toBe("completed");
    expect(prompts).toHaveLength(1);
    await manager.closeAll();
  });

  it("ends with the turn on a runtime that does not name a turn's inputs", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await running).status).toBe("completed");
    expect(prompts).toHaveLength(1);
    await manager.closeAll();
  });

  it("takes back a steer the runtime accepted and then dropped", async () => {
    const { prompts, steers, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [prompts[0]!.id],
    });
    say({
      kind: "input_dropped",
      inputId: steers[0]!.id,
      reason: "turn_interrupted",
    });
    await tick();
    expect(prompts.map((prompt) => prompt.input)).toEqual([
      "start",
      "and this",
    ]);
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [prompts[1]!.id],
    });
    expect((await running).status).toBe("completed");
    await manager.closeAll();
  });

  it("carries a steer the runtime took and died on", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    say({ kind: "exited", code: 1 });
    expect((await running).status).toBe("failed");
    void run(managed, "next");
    await tick();
    expect(prompts.at(-1)!.input).toBe("and this\n\nnext");
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    await tick();
    await manager.closeAll();
  });

  it("opens the runtime again when its process died between runs", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager, opened } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const first = run(managed, "before");
    await tick();
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await first).status).toBe("completed");
    const native = opened[0]!.session.id;
    // Killed while nobody was listening for a turn: an OOM killer, a user's `kill`.
    say({ kind: "exited", code: null });
    await tick();
    const second = run(managed, "after");
    await tick();
    expect(opened).toHaveLength(2);
    expect(opened[1]!.options.resume).toBe(native);
    expect(prompts.at(-1)!.input).toBe("after");
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await second).status).toBe("completed");
    await manager.closeAll();
  });

  it("ends a run whose prompt the runtime handled without a turn", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "/handled");
    await tick();
    // A Pi extension's input handler took it: no turn starts, and none ends.
    say({
      kind: "input_handled",
      requestId: "request-1",
      inputId: prompts[0]!.id,
    });
    expect((await running).status).toBe("completed");
    await manager.closeAll();
  });

  it("leaves a drop named only by its request alone", async () => {
    const { prompts, steers, say, patch } = handDriven();
    const { manager } = setup(() => undefined, { patch });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick();
    managed.session.kernel.steer("and this");
    await tick();
    expect(steers).toHaveLength(1);
    say({
      kind: "input_dropped",
      requestId: "someone-else",
      reason: "turn_interrupted",
    });
    say({
      kind: "turn_ended",
      outcome: { kind: "completed" },
      inputIds: [prompts[0]!.id, steers[0]!.id],
    });
    expect((await running).status).toBe("completed");
    expect(prompts).toHaveLength(1);
    await manager.closeAll();
  });

  it("resumes a conversation the runtime lost under its process, and prompts it again", async () => {
    const { prompts, say, patch } = handDriven();
    let lost = true;
    const { manager, opened } = setup(() => undefined, {
      patch: (session) => {
        const base = patch(session);
        return {
          ...base,
          prompt: async (input, options) => {
            if (!lost) return await base.prompt!(input, options);
            lost = false;
            return {
              kind: "rejected",
              code: "session_not_found",
              reason: "thread not found",
            } as never;
          },
          id: session.id,
        };
      },
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await tick(60);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.options.resume).toBe(opened[0]!.session.id);
    expect(prompts.map((prompt) => prompt.input)).toEqual(["start"]);
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await running).status).toBe("completed");
    await manager.closeAll();
  });

  it("does not take a compaction's own turn for one the runtime began", async () => {
    const { prompts, say, patch } = handDriven();
    const { manager } = setup(() => undefined, {
      manualCompaction: SUPPORTED,
      patch: (session) => ({
        ...patch(session),
        // Claude Code's /compact, as oar 0.128 reports it: a turn of its own, active, then ended.
        compact: async () => {
          say({ kind: "turn_active", sessionId: session.id, seq: 50 });
          await tick();
          say({
            kind: "compaction_ended",
            sessionId: session.id,
            seq: 51,
            outcome: "completed",
          });
          say({
            kind: "turn_ended",
            sessionId: session.id,
            seq: 52,
            outcome: { kind: "completed" },
          });
          return outcome({ kind: "completed" });
        },
      }),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const first = run(managed, "before");
    await tick();
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await first).status).toBe("completed");
    expect((await manager.compactRuntime(managed)).outcome).toBe("completed");
    await tick();
    expect(managed.session.runner.running).toBe(false);
    const after = run(managed, "after");
    await tick();
    expect(prompts.map((prompt) => prompt.input)).toEqual(["before", "after"]);
    say({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect((await after).status).toBe("completed");
    await manager.closeAll();
  });

  it("aborts the runtime's turn", async () => {
    const { manager } = setup(
      async (turn) =>
        await new Promise<void>((resolve) =>
          turn.signal.addEventListener("abort", () => resolve()),
        ),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "wait");
    await new Promise((resolve) => setTimeout(resolve, 50));
    managed.session.runner.abort();
    expect((await running).status).toBe("aborted");
    await manager.closeAll();
  });

  it("picks the runtime conversation back up after a close", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"));
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    const native = created.meta.runtimeSession;
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "after");
    expect(turns[1]!.options.resume).toBe(native);
    // A resumed conversation already heard who the agent is.
    expect(transcript(reopened)).toEqual([
      "user:before",
      "assistant:ok",
      "user:after",
      "assistant:ok",
    ]);
    await manager.closeAll();
  });

  it("resolves the runtime's models, and refuses another provider's", async () => {
    const { manager } = setup((turn) => turn.say("ok"));
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    expect(managed.session.models.getModel("claude", "opus")?.provider).toBe(
      "claude",
    );
    expect(managed.session.models.getModel("anthropic", "x")).toBeUndefined();
    await manager.closeAll();
  });

  it("will not open a runtime this host does not run", async () => {
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("unused");
      },
    });
    await expect(
      manager.create({ cwd: "/work", runtime: "claude" }),
    ).rejects.toThrow(/runtime_unavailable/);
  });
});

/** Call a host tool the way the runtime does: over the MCP server the delegate served it on. */
async function callServed(
  server: { url: string; headers?: Readonly<Record<string, string>> },
  name: string,
): Promise<{ text: string; isError: boolean }> {
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
      params: { name, arguments: {} },
    }),
  });
  const reply = (await response.json()) as {
    result: { content: { text?: string }[]; isError?: boolean };
  };
  return {
    text: reply.result.content.map((part) => part.text ?? "").join(""),
    isError: reply.result.isError === true,
  };
}

describe("the host's tools, served to the runtime", () => {
  /** A host tool whose definition can change under a running session. */
  function changing(name: string) {
    const state = {
      description: `the ${name} tool`,
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
      } as Record<string, unknown>,
    };
    const tool = {
      name,
      get description() {
        return state.description;
      },
      get parameters() {
        return state.parameters;
      },
      execute: () => ({ content: [{ type: "text", text: "done" }] }),
    } as unknown as KernelTool;
    return { tool, state };
  }

  it("are listed anew, with list_changed, when their definitions change between runs", async () => {
    const draft = changing("draft_task");
    const { manager, turns, opened } = setup((turn) => turn.say("ok"), {
      sessionTools: () => [draft.tool, hostTool("list_tasks")],
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "one");
    const server = turns[0]!.options.mcpServers![0] as Served;
    expect((await listServed(server)).map((tool) => tool.name)).toEqual([
      "draft_task",
      "list_tasks",
    ]);
    const stream = await listenServed(server);

    // Nothing changed: nothing is said.
    await run(managed, "two");
    await tick();
    expect(stream.heard).toEqual([]);

    // A parameter is added on the host: the next run serves it and tells the runtime.
    draft.state.parameters = {
      type: "object",
      properties: {
        title: { type: "string" },
        dependsOn: { type: "array", items: { type: "number" } },
      },
    };
    await run(managed, "three");
    await tick();
    expect(stream.heard).toEqual(["notifications/tools/list_changed"]);
    expect(
      (await listServed(server)).find((tool) => tool.name === "draft_task"),
    ).toEqual({
      name: "draft_task",
      description: "the draft_task tool",
      inputSchema: draft.state.parameters,
    });

    // A description counts as much as a schema.
    draft.state.description = "the draft_task tool, now with dependencies";
    await run(managed, "four");
    await tick();
    expect(stream.heard).toHaveLength(2);
    expect(
      (await listServed(server)).find((tool) => tool.name === "draft_task")
        ?.description,
    ).toBe("the draft_task tool, now with dependencies");

    // One runtime session and one server throughout: the list changed, nothing reopened.
    expect(opened).toHaveLength(1);
    stream.close();
    await manager.closeAll();
  });
});

describe("a turn the runtime opens itself", () => {
  /**
   * Claude Code's background subagents: the turn that starts one ends, and when the subagent
   * settles the runtime opens a turn of its own on the notification. The scripted runtime's
   * queue does the same from the outside: a queued input on an idle session starts a turn
   * nobody prompted.
   */
  function notifying(
    onNotification: (
      turn: ScriptedTurn,
      served: () => { url: string; headers?: Readonly<Record<string, string>> },
    ) => Promise<void> | void,
  ) {
    const fixture = setup(
      async (turn) => {
        if (turn.input.startsWith("<task-notification>")) {
          await onNotification(turn, () => {
            const server = turn.options.mcpServers?.[0];
            if (server === undefined || !("url" in server))
              throw new Error("no host tools served");
            return server;
          });
          return;
        }
        turn.task({ taskType: "agent", background: true });
        turn.say("The audit is running.");
      },
      { sessionTools: () => [hostTool("publish_artifact")] },
    );
    const notify = async (text: string) => {
      const runtime = fixture.opened.at(-1)!.session;
      await runtime.queue(`<task-notification>${text}</task-notification>`);
    };
    return { ...fixture, notify };
  }

  /** Until the session has been quiet a while: the runs the notification woke have ended. */
  async function settled(managed: ManagedSession): Promise<void> {
    for (let quiet = 0; quiet < 5; ) {
      await tick(10);
      quiet = managed.session.runner.running ? 0 : quiet + 1;
    }
  }

  it("is a run: its words are journaled and the host's tools answer", async () => {
    const answers: { text: string; isError: boolean }[] = [];
    const { manager, notify } = notifying(async (turn, served) => {
      turn.say("TUI audit is done.");
      await turn.tool("mcp__eta__publish_artifact", "{}", async () => {
        const answer = await callServed(served(), "publish_artifact");
        answers.push(answer);
        return answer.text;
      });
      turn.say("Report published.");
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const runs: string[] = [];
    kernelOn(managed.session.kernel.ctx)("turn:run-end", ({ status }) =>
      runs.push(status),
    );
    expect((await run(managed, "audit the tests")).status).toBe("completed");

    await notify("audit TUI completed");
    await settled(managed);

    expect(answers).toEqual([{ text: "done", isError: false }]);
    expect(runs).toEqual(["completed", "completed"]);
    expect(transcript(managed)).toEqual([
      "user:audit the tests",
      "assistant:The audit is running.",
      "assistant:TUI audit is done.[publish_artifact]",
      "toolResult:done",
      "assistant:Report published.",
    ]);
    await manager.closeAll();
  });

  it("takes each of several notifications as a run", async () => {
    const { manager, notify } = notifying((turn) => {
      turn.say(`heard ${turn.input.replace(/<\/?task-notification>/g, "")}`);
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "audit the tests");
    await notify("one");
    await settled(managed);
    await notify("two");
    await settled(managed);
    expect(transcript(managed)).toEqual([
      "user:audit the tests",
      "assistant:The audit is running.",
      "assistant:heard one",
      "assistant:heard two",
    ]);
    await manager.closeAll();
  });

  it("lets a message that arrives during it wait for its end, then prompts it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { manager, notify, turns } = notifying(async (turn) => {
      turn.say("working on the notification");
      await held;
      turn.say(" and done");
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "audit the tests");
    await notify("audit done");
    await tick();
    expect(managed.session.runner.running).toBe(true);
    // The user writes while the runtime's own turn is still going, and waits as a reply does
    // (`runAndWait`): the run in flight is the runtime's, and the next one takes the words.
    const { kernel, runner } = managed.session;
    kernel.nextRun("any report yet?");
    const asked = runner.run();
    release();
    let result = await asked;
    while (result.status === "completed" && kernel.inboxDepth > 0)
      result = await runner.run();
    expect(result.status).toBe("completed");
    await settled(managed);
    expect(turns.map((turn) => turn.input)).toEqual([
      "audit the tests",
      "<task-notification>audit done</task-notification>",
      "any report yet?",
    ]);
    expect(transcript(managed)).toContain(
      "assistant:working on the notification and done",
    );
    expect(transcript(managed).slice(-2)).toEqual([
      "user:any report yet?",
      "assistant:The audit is running.",
    ]);
    await manager.closeAll();
  });
});

describe("letting an idle runtime's process go", () => {
  const idle = { idleMs: 60_000, maxResident: 0, everyMs: 3_600_000 };
  const later = () => Date.now() + 120_000;

  it("lets an idle one go and resumes its conversation at the next run", async () => {
    const { manager, turns, opened } = setup((turn) => turn.say("ok"), {
      runtimeIdle: idle,
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "before");
    const native = managed.meta.runtimeSession;
    expect(await manager.sweepRuntimes()).toEqual([]);
    expect(await manager.sweepRuntimes(later())).toEqual([managed.meta.id]);
    // The process is gone: the runtime answered the dispose with its exit.
    expect(
      opened[0]!.session
        .records()
        .some(
          (record) =>
            record.kind === "response" && record.body.kind === "exited",
        ),
    ).toBe(true);
    // Nothing left to let go.
    expect(await manager.sweepRuntimes(later())).toEqual([]);
    await run(managed, "after");
    expect(opened).toHaveLength(2);
    expect(turns[1]!.options.resume).toBe(native);
    expect(transcript(managed)).toEqual([
      "user:before",
      "assistant:ok",
      "user:after",
      "assistant:ok",
    ]);
    await manager.closeAll();
  });

  it("keeps it while a run is under way", async () => {
    let finish: (() => void) | undefined;
    const { manager } = setup(
      async (turn) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        turn.say("done");
      },
      { runtimeIdle: idle },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "work");
    await tick();
    expect(await manager.sweepRuntimes(later())).toEqual([]);
    finish!();
    await running;
    expect(await manager.sweepRuntimes(later())).toEqual([managed.meta.id]);
    await manager.closeAll();
  });

  it("keeps it while a task runs in the background, and lets it go once that ends", async () => {
    let task: { end: () => void } | undefined;
    const { manager } = setup(
      (turn) => {
        task = turn.task({ taskType: "shell", background: true });
        turn.say("started");
      },
      { runtimeIdle: idle },
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "start it");
    expect(await manager.sweepRuntimes(later())).toEqual([]);
    task!.end();
    await tick();
    expect(await manager.sweepRuntimes(later())).toEqual([managed.meta.id]);
    await manager.closeAll();
  });

  it("keeps no more than the cap, letting the least recently active go first", async () => {
    const { manager } = setup((turn) => turn.say("ok"), {
      runtimeIdle: { idleMs: 0, maxResident: 1, everyMs: 3_600_000 },
    });
    const older = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(older, "one");
    await tick(5);
    const newer = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(newer, "two");
    expect(await manager.sweepRuntimes()).toEqual([older.meta.id]);
    expect(await manager.sweepRuntimes()).toEqual([]);
    await manager.closeAll();
  });

  it("never lets one go when there is no policy", async () => {
    const { manager } = setup((turn) => turn.say("ok"), { runtimeIdle: null });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "hello");
    expect(await manager.sweepRuntimes(later())).toEqual([]);
    await manager.closeAll();
  });
});
