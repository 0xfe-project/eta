/**
 * Tests for built-in In-Process eta Internal Events trigger provider (`EtaEventsTriggerProvider`):
 * - Catalog listing (`task.status.changed`, `task.run.finished`), source/query filtering
 * - Config validation (`provision()` rejects bad triggers/sources/modes/filters with readable errors)
 * - Filter matching (`to`, `from`, `status`, `assignee` by id or name) on hit & miss
 * - Same-status updates and failed writes do NOT emit events
 * - Listener / emitter failures are caught & warned without disrupting task board writes
 * - Deduplication via `eventId`, disable, delete, `stop()`, and restart binding recovery
 * - End-to-end integration with `TaskBoard`, `TaskRunner`, `TriggerHub`, and `RoutineRunner`
 */
import type {
  RoutineArgs,
  RoutineSections,
  RoutineSummary,
  RunView,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { AgentRecord } from "../src/agents/store";
import type { ConversationRecord } from "../src/conversations/store";
import type { HostOptions } from "../src/host";
import type {
  IncomingTriggerEvent,
  TriggerBinding,
} from "../src/routines/triggers";
import type { Request as ModelRequest } from "./support/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  EtaEventBus,
  EtaEventsTriggerProvider,
  TASK_RUN_FINISHED_TRIGGER,
  TASK_STATUS_CHANGED_TRIGGER,
} from "../src/routines/eta-events-triggers";
import {
  TRIGGER_EVENTS_CLOSE,
  TRIGGER_EVENTS_OPEN,
} from "../src/routines/prompts";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const isRoutineRun = (request: ModelRequest): boolean =>
  (request.transcript[0] ?? "").includes("<routine-run>");
const isTaskRun = (request: ModelRequest): boolean =>
  request.system.includes("In this task you are");
const step = (request: ModelRequest): number =>
  request.transcript.filter((line) => line.startsWith("assistant:")).length;
const report = (title: string, body: string) => call("report", { title, body });

interface Origin {
  groupId: string | null;
  groupName: string | null;
  groupKind: "group" | "captain" | null;
  creator: string | null;
  creatorName: string | null;
}

const NO_ORIGIN: Origin = {
  groupId: null,
  groupName: null,
  groupKind: null,
  creator: null,
  creatorName: null,
};

/** What the group, creator and assignee dropdowns list: two groups (one archived), Captain's chat, three agents. */
function directory() {
  const conversation = (
    id: string,
    kind: string,
    name: string,
    archived: boolean,
  ) => ({ id, kind, name, archived }) as ConversationRecord;
  const conversations = [
    conversation("g-eng", "group", "eng", false),
    conversation("g-old", "group", "old", true),
    conversation("c-captain", "captain", "Captain chat", false),
  ];
  const agents = [
    { id: "agent-forge", name: "Forge", systemRole: null },
    { id: "agent-atlas", name: "Atlas", systemRole: null },
    { id: "agent-captain", name: "Captain", systemRole: "captain" },
  ] as AgentRecord[];
  return {
    conversations: {
      ofKind: (kind: string) => conversations.filter((c) => c.kind === kind),
    },
    agents: { list: () => agents },
  };
}

const statusEvent = (
  eventId: string,
  origin: Partial<Origin>,
  assignee = { id: "agent-forge", name: "Forge" },
) =>
  ({
    type: TASK_STATUS_CHANGED_TRIGGER,
    eventId,
    occurredAt: 1,
    payload: {
      taskId: "t1",
      number: 1,
      title: "Task One",
      from: "in_progress",
      to: "in_review",
      assignee: assignee.id,
      assigneeName: assignee.name,
      ...NO_ORIGIN,
      ...origin,
      actor: { kind: "user", agentId: null },
      reason: null,
      occurredAt: 1,
    },
  }) as const;

const runEvent = (eventId: string, origin: Partial<Origin>) =>
  ({
    type: TASK_RUN_FINISHED_TRIGGER,
    eventId,
    occurredAt: 1,
    payload: {
      taskId: "t1",
      number: 1,
      title: "Task One",
      runId: "run-1",
      status: "completed",
      reason: null,
      errorCode: null,
      agentId: null,
      assignee: "agent-forge",
      assigneeName: "Forge",
      ...NO_ORIGIN,
      ...origin,
      startedAt: 0,
      finishedAt: 1,
      occurredAt: 1,
    },
  }) as const;

const binding = (
  routineId: string,
  trigger: string,
  config: Record<string, unknown>,
): TriggerBinding => ({
  routineId,
  enabled: true,
  instanceId: `eta-events:${routineId}`,
  trigger: { provider: "eta-events", source: "tasks", trigger, config },
});

describe("eta-events unit: catalog, config validation, filtering, and lifecycle", () => {
  it("lists extensible internal events and filters by source and query", async () => {
    const bus = new EtaEventBus();
    const provider = new EtaEventsTriggerProvider({ bus, ...directory() });

    expect(provider.status()).toEqual({
      provider: "eta-events",
      status: "ready",
    });

    const all = await provider.listTriggers();
    expect(all.map((item) => item.trigger)).toEqual([
      "task.status.changed",
      "task.run.finished",
    ]);
    expect(all.every((item) => item.modes.length === 0)).toBe(true);

    const bySource = await provider.listTriggers({ source: "tasks" });
    expect(bySource).toHaveLength(2);
    expect(await provider.listTriggers({ source: "unknown" })).toEqual([]);

    const byQuery = await provider.listTriggers({ query: "run ends" });
    expect(byQuery.map((item) => item.trigger)).toEqual(["task.run.finished"]);
  });

  it("rejects invalid trigger config in provision() with readable errors", async () => {
    const bus = new EtaEventBus();
    const provider = new EtaEventsTriggerProvider({ bus, ...directory() });

    const invalidCases: {
      trigger: Parameters<EtaEventsTriggerProvider["provision"]>[0]["trigger"];
      pattern: RegExp;
    }[] = [
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.unknown",
        },
        pattern: /Unsupported eta-events trigger/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "wrong-source",
          trigger: "task.status.changed",
        },
        pattern: /Unsupported source/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          mode: "poll",
        },
        pattern: /do not support delivery mode/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          pollingIntervalMinutes: 5,
        },
        pattern: /do not support polling intervals/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          accountId: "acc_1",
        },
        pattern: /do not use connected accounts/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          config: { to: ["not_a_status"] },
        },
        pattern: /Invalid value "not_a_status" in "to" filter/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          config: { to: "in_review" },
        },
        pattern: /Filter "to" must be an array/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.run.finished",
          config: { status: ["running"] },
        },
        pattern: /Invalid value "running" in "status" filter/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          config: { assignee: 123 },
        },
        pattern: /Filter "assignee" must be a string/,
      },
      {
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: "task.status.changed",
          config: { unknownField: true },
        },
        pattern: /Unknown config field "unknownField"/,
      },
    ];

    for (const item of invalidCases) {
      await expect(
        provider.provision({
          routineId: "r-bad",
          trigger: item.trigger,
          enabled: true,
          existingInstanceId: null,
        }),
      ).rejects.toThrow(item.pattern);
    }
  });

  it("matches filters accurately, isolates listener failures, and restores bindings after provider restart", async () => {
    const warnings: string[] = [];
    const bus = new EtaEventBus({ warn: (msg) => warnings.push(msg) });
    const now = () => 1_700_000_000_000;
    const provider1 = new EtaEventsTriggerProvider({
      bus,
      ...directory(),
      now,
      warn: (msg) => warnings.push(msg),
    });

    const bindings: TriggerBinding[] = [
      {
        routineId: "r-status",
        enabled: true,
        instanceId: "eta-events:r-status",
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: TASK_STATUS_CHANGED_TRIGGER,
          config: {
            to: ["in_review", "blocked"],
            from: ["in_progress"],
            assignee: "Forge",
          },
        },
      },
      {
        routineId: "r-run",
        enabled: true,
        instanceId: "eta-events:r-run",
        trigger: {
          provider: "eta-events",
          source: "tasks",
          trigger: TASK_RUN_FINISHED_TRIGGER,
          config: { status: ["failed"] },
        },
      },
    ];

    const emitted: IncomingTriggerEvent[] = [];
    provider1.start({
      bindings: () => bindings,
      onEvent: (ev) => emitted.push(ev),
      onBindingsChanged: () => undefined,
    });
    expect(provider1.armedCount()).toBe(2);

    // Miss: wrong target status
    bus.emit({
      type: TASK_STATUS_CHANGED_TRIGGER,
      eventId: "ev-miss-to",
      occurredAt: 100,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        from: "in_progress",
        to: "done",
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        actor: { kind: "agent", agentId: "agent-forge" },
        reason: null,
        occurredAt: 100,
      },
    });
    // Miss: wrong assignee
    bus.emit({
      type: TASK_STATUS_CHANGED_TRIGGER,
      eventId: "ev-miss-assignee",
      occurredAt: 101,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        from: "in_progress",
        to: "in_review",
        assignee: "agent-other",
        assigneeName: "Atlas",
        ...NO_ORIGIN,
        actor: { kind: "agent", agentId: "agent-other" },
        reason: null,
        occurredAt: 101,
      },
    });
    // Hit: matches from, to, and assigneeName (case-insensitive)
    bus.emit({
      type: TASK_STATUS_CHANGED_TRIGGER,
      eventId: "ev-hit-status",
      occurredAt: 102,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        from: "in_progress",
        to: "in_review",
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        actor: { kind: "agent", agentId: "agent-forge" },
        reason: null,
        occurredAt: 102,
      },
    });
    // Miss: run completed (filter only accepts failed)
    bus.emit({
      type: TASK_RUN_FINISHED_TRIGGER,
      eventId: "ev-miss-run",
      occurredAt: 103,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        runId: "run-1",
        status: "completed",
        reason: null,
        errorCode: null,
        agentId: null,
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        startedAt: 90,
        finishedAt: 103,
        occurredAt: 103,
      },
    });
    // Hit: run failed
    bus.emit({
      type: TASK_RUN_FINISHED_TRIGGER,
      eventId: "ev-hit-run",
      occurredAt: 104,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        runId: "run-2",
        status: "failed",
        reason: "Process exited with code 1",
        errorCode: null,
        agentId: null,
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        startedAt: 95,
        finishedAt: 104,
        occurredAt: 104,
      },
    });

    expect(emitted.map((e) => e.eventId)).toEqual([
      "ev-hit-status",
      "ev-hit-run",
    ]);

    // Throwing listener on bus does not affect subsequent listeners or throw to caller.
    const unsubBroken = bus.subscribe(() => {
      throw new Error("boom");
    });
    expect(() =>
      bus.emit({
        type: TASK_STATUS_CHANGED_TRIGGER,
        eventId: "ev-after-throw",
        occurredAt: 105,
        payload: {
          taskId: "t1",
          number: 1,
          title: "Task One",
          from: "in_progress",
          to: "blocked",
          assignee: "agent-forge",
          assigneeName: "Forge",
          ...NO_ORIGIN,
          actor: { kind: "agent", agentId: "agent-forge" },
          reason: "Waiting",
          occurredAt: 105,
        },
      }),
    ).not.toThrow();
    expect(warnings.some((w) => w.includes("boom"))).toBe(true);
    expect(emitted.map((e) => e.eventId)).toEqual([
      "ev-hit-status",
      "ev-hit-run",
      "ev-after-throw",
    ]);
    unsubBroken();

    // Stop unsubscribes and clears armed state.
    provider1.stop();
    expect(provider1.armedCount()).toBe(0);
    bus.emit({
      type: TASK_STATUS_CHANGED_TRIGGER,
      eventId: "ev-while-stopped",
      occurredAt: 106,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        from: "in_progress",
        to: "in_review",
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        actor: { kind: "agent", agentId: "agent-forge" },
        reason: null,
        occurredAt: 106,
      },
    });
    expect(emitted).toHaveLength(3);

    // Restart with a fresh provider instance restores bindings from host.bindings().
    const provider2 = new EtaEventsTriggerProvider({
      bus,
      ...directory(),
      now,
      warn: (msg) => warnings.push(msg),
    });
    const emitted2: IncomingTriggerEvent[] = [];
    provider2.start({
      bindings: () => bindings,
      onEvent: (ev) => emitted2.push(ev),
      onBindingsChanged: () => undefined,
    });
    expect(provider2.armedCount()).toBe(2);

    bus.emit({
      type: TASK_STATUS_CHANGED_TRIGGER,
      eventId: "ev-post-restart",
      occurredAt: 107,
      payload: {
        taskId: "t1",
        number: 1,
        title: "Task One",
        from: "in_progress",
        to: "in_review",
        assignee: "agent-forge",
        assigneeName: "Forge",
        ...NO_ORIGIN,
        actor: { kind: "agent", agentId: "agent-forge" },
        reason: null,
        occurredAt: 107,
      },
    });
    expect(emitted2.map((e) => e.eventId)).toEqual(["ev-post-restart"]);
    provider2.stop();
  });

  it("lists group, creator and assignee as dropdowns built from the current groups and agents", async () => {
    const provider = new EtaEventsTriggerProvider({
      bus: new EtaEventBus(),
      ...directory(),
    });
    for (const item of await provider.listTriggers()) {
      const properties = (
        item.configSchema as { properties: Record<string, any> }
      ).properties;
      expect(properties.group).toMatchObject({
        type: "string",
        enum: ["g-eng", "c-captain"],
        enumNames: ["eng", "Captain chat"],
      });
      expect(properties.creator).toMatchObject({
        type: "string",
        enum: ["agent-forge", "agent-atlas", "agent-captain"],
        enumNames: ["Forge", "Atlas", "Captain"],
      });
      expect(properties.assignee).toMatchObject({
        type: "string",
        enum: ["agent-forge", "agent-atlas"],
        enumNames: ["Forge", "Atlas"],
      });
    }
    const [status, run] = await provider.listTriggers();
    expect(Object.keys((status!.configSchema as any).properties)).toEqual([
      "to",
      "from",
      "group",
      "creator",
      "assignee",
    ]);
    expect(Object.keys((run!.configSchema as any).properties)).toEqual([
      "status",
      "group",
      "creator",
      "assignee",
    ]);
  });

  it("filters by group, creator and assignee, and combines them with and", async () => {
    const bus = new EtaEventBus();
    const provider = new EtaEventsTriggerProvider({ bus, ...directory() });
    const bindings = [
      binding("r-all", TASK_STATUS_CHANGED_TRIGGER, {}),
      binding("r-group", TASK_STATUS_CHANGED_TRIGGER, { group: "g-eng" }),
      binding("r-captain", TASK_STATUS_CHANGED_TRIGGER, { group: "c-captain" }),
      binding("r-creator", TASK_STATUS_CHANGED_TRIGGER, {
        creator: "agent-atlas",
      }),
      binding("r-legacy", TASK_STATUS_CHANGED_TRIGGER, { assignee: "forge" }),
      binding("r-and", TASK_STATUS_CHANGED_TRIGGER, {
        group: "g-eng",
        creator: "agent-atlas",
        assignee: "agent-forge",
      }),
      binding("r-gone", TASK_STATUS_CHANGED_TRIGGER, { group: "g-deleted" }),
    ];
    const hits: string[] = [];
    provider.start({
      bindings: () => bindings,
      onEvent: (ev) => hits.push(`${ev.eventId}>${ev.routineId}`),
      onBindingsChanged: () => undefined,
    });
    expect(provider.armedCount()).toBe(bindings.length);

    const inEng = {
      groupId: "g-eng",
      groupName: "eng",
      groupKind: "group",
    } as const;
    const byAtlas = { creator: "agent-atlas", creatorName: "Atlas" };
    bus.emit(statusEvent("none", {}));
    bus.emit(statusEvent("eng", inEng));
    bus.emit(
      statusEvent("captain", {
        groupId: "c-captain",
        groupName: "Captain chat",
        groupKind: "captain",
      }),
    );
    bus.emit(statusEvent("atlas", byAtlas));
    bus.emit(statusEvent("eng-atlas", { ...inEng, ...byAtlas }));
    bus.emit(
      statusEvent(
        "eng-atlas-other-assignee",
        { ...inEng, ...byAtlas },
        {
          id: "agent-atlas",
          name: "Atlas",
        },
      ),
    );

    const by = (routineId: string) =>
      hits
        .filter((h) => h.endsWith(`>${routineId}`))
        .map((h) => h.split(">")[0]!);
    // No filter: every event. A user's task (no creator) and a task without a group still pass.
    expect(by("r-all")).toEqual([
      "none",
      "eng",
      "captain",
      "atlas",
      "eng-atlas",
      "eng-atlas-other-assignee",
    ]);
    expect(by("r-group")).toEqual([
      "eng",
      "eng-atlas",
      "eng-atlas-other-assignee",
    ]);
    expect(by("r-captain")).toEqual(["captain"]);
    expect(by("r-creator")).toEqual([
      "atlas",
      "eng-atlas",
      "eng-atlas-other-assignee",
    ]);
    // A saved assignee name from before the dropdown still matches.
    expect(by("r-legacy")).toEqual([
      "none",
      "eng",
      "captain",
      "atlas",
      "eng-atlas",
    ]);
    expect(by("r-and")).toEqual(["eng-atlas"]);
    // A group that no longer exists arms without error and never matches.
    expect(by("r-gone")).toEqual([]);
    provider.stop();
  });

  it("does not match a group or creator filter on a run whose task is gone", async () => {
    const bus = new EtaEventBus();
    const provider = new EtaEventsTriggerProvider({ bus, ...directory() });
    const bindings = [
      binding("r-all", TASK_RUN_FINISHED_TRIGGER, {}),
      binding("r-group", TASK_RUN_FINISHED_TRIGGER, { group: "g-eng" }),
      binding("r-creator", TASK_RUN_FINISHED_TRIGGER, {
        creator: "agent-atlas",
      }),
    ];
    const hits: string[] = [];
    provider.start({
      bindings: () => bindings,
      onEvent: (ev) => hits.push(ev.routineId!),
      onBindingsChanged: () => undefined,
    });
    bus.emit(runEvent("gone", {}));
    expect(hits).toEqual(["r-all"]);
    bus.emit(
      runEvent("found", {
        groupId: "g-eng",
        groupName: "eng",
        groupKind: "group",
        creator: "agent-atlas",
        creatorName: "Atlas",
      }),
    );
    expect(hits).toEqual(["r-all", "r-all", "r-group", "r-creator"]);
    provider.stop();
  });

  it("stores group and creator in the trigger config, drops empty ones, and rejects bad values", async () => {
    const provider = new EtaEventsTriggerProvider({
      bus: new EtaEventBus(),
      ...directory(),
    });
    const provision = (config: Record<string, unknown>) =>
      provider.provision({
        routineId: "r-config",
        trigger: binding("r-config", TASK_RUN_FINISHED_TRIGGER, config).trigger,
        enabled: true,
        existingInstanceId: null,
      });

    expect(
      (await provision({ group: " g-eng ", creator: "", assignee: "forge" }))
        .config,
    ).toEqual({
      group: "g-eng",
      assignee: "forge",
    });
    await expect(provision({ group: 7 })).rejects.toThrow(
      /Filter "group" must be a string/,
    );
    await expect(provision({ creator: ["a"] })).rejects.toThrow(
      /Filter "creator" must be a string/,
    );
    await expect(provision({ group: "x".repeat(201) })).rejects.toThrow(
      /Filter "group" must be at most 200 characters/,
    );
  });
});

describe("eta-events e2e with TaskBoard, TaskRunner, TriggerHub, and host restart", () => {
  let closeHost: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeHost) {
      await closeHost();
      closeHost = undefined;
    }
  });

  async function startWorld(
    dataDir: string,
    answer: Parameters<typeof scriptedModels>[0],
    clockRef: { value: number },
    extra: Partial<HostOptions> = {},
  ) {
    const { models } = scriptedModels(answer);
    const w = await world({
      dataDir,
      captain: true,
      models,
      tasks: { runs: false },
      ...extra,
      routines: {
        now: () => clockRef.value,
        timer: false,
        coalesceMs: 10,
        ...extra.routines,
      },
    });
    w.client.subscribe("routines");
    const act = async <A extends keyof RoutineArgs, R = unknown>(
      action: A,
      args: RoutineArgs[A],
    ): Promise<R> => (await w.client.call("routines", action, args)) as R;

    const watch = async (id: string) => {
      w.client.subscribe(`routines.${id}`);
      await until(
        () => w.client.section(`routines.${id}`, "info") !== undefined,
      );
    };
    const sections = (id: string) => ({
      runs: () => w.client.section<RunView[]>(`routines.${id}`, "runs") ?? [],
      info: () =>
        w.client.section<RoutineSections["info"]>(`routines.${id}`, "info")!,
    });

    return {
      w,
      act,
      watch,
      sections,
      close: async () => {
        await w.client.close();
        await w.host.close();
      },
    };
  }

  it("triggers on task status changes, ignores no-op updates & failed writes, isolates emission errors, deduplicates, and recovers across restart", async () => {
    const dataDir = await tempDir("eta-events-e2e-");
    const clock = { value: Date.parse("2026-11-28T10:00:00Z") };
    const runPrompts1: string[] = [];

    const t1 = await startWorld(
      dataDir,
      (req) => {
        if (!isRoutineRun(req)) return say("ok");
        if (step(req) === 0) {
          runPrompts1.push(req.last);
          return report("Task Event Handled", "Processed task state change.");
        }
        return say("Done.");
      },
      clock,
    );
    closeHost = t1.close;

    const ada = await t1.w.agent("Ada");
    const bob = await t1.w.agent("Bob");
    const project = await t1.w.project();
    const group = await t1.w.group(project.id, [ada.id, bob.id], "eng");

    // 1. Invalid config puts trigger into error state without crashing.
    const { routine: broken } = await t1.act<
      "create",
      { routine: RoutineSummary }
    >("create", {
      name: "Broken Event Watch",
      brief: "Watch invalid event.",
      schedule: null,
      trigger: {
        provider: "eta-events",
        source: "tasks",
        trigger: "task.status.changed",
        config: { to: ["bogus_status"] },
      },
      timezone: "UTC",
    });
    await t1.watch(broken.id);
    expect(t1.sections(broken.id).info().trigger?.status).toBe("error");
    expect(t1.sections(broken.id).info().trigger?.lastError).toMatch(
      /bogus_status/,
    );
    await t1.act("delete", { routineId: broken.id });

    // 2. Create filtered routine: only Ada's tasks moving to in_review or blocked.
    const { routine: created } = await t1.act<
      "create",
      { routine: RoutineSummary }
    >("create", {
      name: "Ada Review Watcher",
      brief: "Summarize when Ada's task enters review or blocked.",
      schedule: null,
      trigger: {
        provider: "eta-events",
        source: "tasks",
        trigger: "task.status.changed",
        config: {
          to: ["in_review", "blocked"],
          assignee: "Ada",
        },
      },
      timezone: "UTC",
    });
    await t1.watch(created.id);
    expect(t1.sections(created.id).info().trigger).toMatchObject({
      provider: "eta-events",
      source: "tasks",
      trigger: "task.status.changed",
      status: "active",
      mode: null,
      pollingIntervalMinutes: null,
      lastEventAt: null,
      config: {
        to: ["in_review", "blocked"],
        assignee: "Ada",
      },
    });

    const taskAda = t1.w.host.product.board.create(
      {
        title: "Implement cache",
        description: "Add LRU cache",
        conversationId: group.id,
        workspace: "local",
        assignee: ada.id,
      },
      { kind: "agent", agentId: ada.id },
    );
    const taskBob = t1.w.host.product.board.create(
      {
        title: "Update docs",
        description: "Write guide",
        conversationId: group.id,
        workspace: "local",
        assignee: bob.id,
      },
      { kind: "agent", agentId: bob.id },
    );

    // Misses: wrong target status (todo -> in_progress) and wrong assignee (Bob -> in_review).
    t1.w.host.product.board.update(
      taskAda.id,
      { status: "in_progress" },
      { kind: "agent", agentId: ada.id },
    );
    t1.w.host.product.board.update(
      taskBob.id,
      { status: "in_review" },
      { kind: "agent", agentId: bob.id },
    );
    // Failed update must not emit.
    expect(() =>
      t1.w.host.product.board.update(
        taskAda.id,
        { status: "not_a_real_status" },
        { kind: "user", agentId: null },
      ),
    ).toThrow();
    expect(runPrompts1).toHaveLength(0);

    // Hit: Ada's task moves to in_review -> triggers once.
    clock.value += 60_000;
    t1.w.host.product.board.update(
      taskAda.id,
      { status: "in_review" },
      { kind: "agent", agentId: ada.id },
    );
    await until(() => t1.sections(created.id).runs()[0]?.status === "sent");
    expect(runPrompts1).toHaveLength(1);
    expect(runPrompts1[0]).toContain(TRIGGER_EVENTS_OPEN);
    expect(runPrompts1[0]).toContain("Implement cache");
    expect(runPrompts1[0]).toContain('"from": "in_progress"');
    expect(runPrompts1[0]).toContain('"to": "in_review"');
    expect(runPrompts1[0]).toContain(TRIGGER_EVENTS_CLOSE);
    expect(t1.sections(created.id).info().trigger?.lastEventAt).toBe(
      clock.value,
    );

    // Same-status update must NOT emit.
    t1.w.host.product.board.update(
      taskAda.id,
      { status: "in_review", title: "Implement cache v2" },
      { kind: "user", agentId: null },
    );
    expect(
      t1.w.host.product.routines.store.triggerEventsOfRoutine(created.id),
    ).toHaveLength(1);

    // Duplicate eventId ingestion is ignored.
    const stored = t1.w.host.product.routines.store.triggerEventsOfRoutine(
      created.id,
    )[0]!;
    const dup = t1.w.host.product.routines.triggers.ingest({
      provider: "eta-events",
      instanceId: `eta-events:${created.id}`,
      routineId: created.id,
      triggerSlug: "task.status.changed",
      source: "tasks",
      accountId: null,
      eventId: stored.eventId,
      occurredAt: clock.value,
      payload: stored.payload,
    });
    expect(dup).toBe(0);

    // Throwing status listener must not prevent task write from committing.
    const offBrokenListener = t1.w.host.product.board.onStatusChange(() => {
      throw new Error("simulated listener crash");
    });
    const updatedTask = t1.w.host.product.board.update(
      taskAda.id,
      { status: "done" },
      { kind: "user", agentId: null },
    );
    expect(updatedTask.status).toBe("done");
    expect(t1.w.host.product.board.detail(taskAda.id)?.status).toBe("done");
    offBrokenListener();

    // Disable pauses triggers; re-enable restores active state.
    await t1.act("update", { routineId: created.id, enabled: false });
    expect(t1.sections(created.id).info().trigger?.status).toBe("disabled");
    t1.w.host.product.board.update(
      taskAda.id,
      { status: "blocked" },
      { kind: "user", agentId: null },
    );
    expect(
      t1.w.host.product.routines.store.triggerEventsOfRoutine(created.id),
    ).toHaveLength(1);
    await t1.act("update", { routineId: created.id, enabled: true });
    expect(t1.sections(created.id).info().trigger?.status).toBe("active");

    // 3. Restart host on same dataDir -> binding restores automatically and triggers on next event.
    await t1.close();
    closeHost = undefined;

    const runPrompts2: string[] = [];
    const t2 = await startWorld(
      dataDir,
      (req) => {
        if (!isRoutineRun(req)) return say("ok");
        if (step(req) === 0) {
          runPrompts2.push(req.last);
          return report("Post-restart Task Event", "Handled after restart.");
        }
        return say("Done.");
      },
      clock,
    );
    closeHost = t2.close;
    await t2.watch(created.id);
    expect(t2.sections(created.id).info().trigger?.status).toBe("active");

    clock.value += 60_000;
    t2.w.host.product.board.update(
      taskAda.id,
      { status: "in_review" },
      { kind: "agent", agentId: ada.id },
    );
    await until(
      () =>
        t2.sections(created.id).runs().length === 2 &&
        t2.sections(created.id).runs()[0]?.status === "sent",
    );
    expect(runPrompts2).toHaveLength(1);
    expect(runPrompts2[0]).toContain("Implement cache v2");

    // Delete routine cleans up trigger.
    await t2.act("delete", { routineId: created.id });
    expect(
      t2.w.host.product.routines.store.trigger(created.id),
    ).toBeUndefined();

    // Catalog RPC exposes eta-events.
    const catalog = await t2.act<
      "triggers",
      { triggers: TriggerCatalogItem[]; providers: TriggerProviderStatus[] }
    >("triggers", { provider: "eta-events" });
    expect(catalog.triggers.map((i) => i.trigger)).toEqual([
      "task.run.finished",
      "task.status.changed",
    ]);
    expect(catalog.providers).toEqual([
      { provider: "eta-events", status: "ready" },
    ]);
  }, 30_000);

  it("triggers task.run.finished when a real task run completes via finish_task", async () => {
    const dataDir = await tempDir("eta-events-run-finished-");
    const clock = { value: Date.parse("2026-11-28T11:00:00Z") };
    const routinePrompts: string[] = [];

    const { models } = scriptedModels((req) => {
      if (isTaskRun(req)) {
        return req.lastRole === "toolResult"
          ? say("Finished task.")
          : call("finish_task", { summary: "Implemented feature X." });
      }
      if (isRoutineRun(req)) {
        if (step(req) === 0) {
          routinePrompts.push(req.last);
          return report("Run Finished Alert", "Observed task run completion.");
        }
        return say("Done.");
      }
      return say("ok");
    });

    const w = await world({
      dataDir,
      captain: true,
      models,
      routines: {
        now: () => clock.value,
        timer: false,
        coalesceMs: 10,
      },
    });
    closeHost = async () => {
      await w.client.close();
      await w.host.close();
    };
    w.client.subscribe("routines");

    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "core");

    const { routine } = (await w.client.call("routines", "create", {
      name: "Run Completion Watcher",
      brief: "Record completed task runs.",
      schedule: null,
      trigger: {
        provider: "eta-events",
        source: "tasks",
        trigger: "task.run.finished",
        config: { status: ["completed"] },
      },
      timezone: "UTC",
    })) as { routine: RoutineSummary };

    w.client.subscribe(`routines.${routine.id}`);
    await until(
      () => w.client.section(`routines.${routine.id}`, "info") !== undefined,
    );

    w.host.product.board.create(
      {
        title: "Build feature X",
        description: "Ship feature X",
        conversationId: group.id,
        workspace: "local",
        assignee: ada.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    await until(
      () =>
        w.client.section<RunView[]>(`routines.${routine.id}`, "runs")?.[0]
          ?.status === "sent",
    );
    expect(routinePrompts).toHaveLength(1);
    expect(routinePrompts[0]).toContain("task.run.finished");
    expect(routinePrompts[0]).toContain("Build feature X");
    expect(routinePrompts[0]).toContain('"status": "completed"');
  }, 30_000);

  it("puts the source group, Captain's chat and the creator on the event payload and filters on them", async () => {
    const dataDir = await tempDir("eta-events-origin-");
    const clock = { value: Date.parse("2026-11-28T12:00:00Z") };
    const { models } = scriptedModels((req) =>
      isRoutineRun(req) && step(req) === 0
        ? report("Seen", "Seen.")
        : say("ok"),
    );
    const w = await world({
      dataDir,
      captain: true,
      models,
      tasks: { runs: false },
      routines: { now: () => clock.value, timer: false, coalesceMs: 10 },
    });
    closeHost = async () => {
      await w.client.close();
      await w.host.close();
    };
    w.client.subscribe("routines");
    const act = async <A extends keyof RoutineArgs, R = unknown>(
      action: A,
      args: RoutineArgs[A],
    ): Promise<R> => (await w.client.call("routines", action, args)) as R;

    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id], "eng");
    const { conversationId: captainConversationId } = (await w.client.call(
      "captain",
      "direct",
      {},
    )) as { conversationId: string };

    const create = async (name: string, config: Record<string, unknown>) =>
      (
        await act<"create", { routine: RoutineSummary }>("create", {
          name,
          brief: "Record the event.",
          schedule: null,
          trigger: {
            provider: "eta-events",
            source: "tasks",
            trigger: "task.status.changed",
            config,
          },
          timezone: "UTC",
        })
      ).routine;
    const all = await create("All", {});
    const inGroup = await create("Group", { group: group.id });
    const inCaptain = await create("Captain", { group: captainConversationId });
    const byBob = await create("Creator", { creator: bob.id });
    const bad = await create("Bad", { group: 7 });
    for (const routine of [all, inGroup, inCaptain, byBob, bad]) {
      w.client.subscribe(`routines.${routine.id}`);
      await until(
        () => w.client.section(`routines.${routine.id}`, "info") !== undefined,
      );
    }
    const info = (id: string) =>
      w.client.section<RoutineSections["info"]>(`routines.${id}`, "info")!;
    expect(info(bad.id).trigger?.status).toBe("error");
    expect(info(bad.id).trigger?.lastError).toMatch(
      /Filter "group" must be a string/,
    );

    const board = w.host.product.board;
    const inEng = board.create(
      {
        title: "In group",
        conversationId: group.id,
        workspace: "local",
        assignee: ada.id,
      },
      { kind: "agent", agentId: bob.id },
    );
    const inCaptainChat = board.create(
      {
        title: "In Captain's chat",
        conversationId: captainConversationId,
        workspace: "local",
        assignee: ada.id,
      },
      { kind: "agent", agentId: ada.id },
    );
    board.update(
      inEng.id,
      { status: "in_progress" },
      { kind: "user", agentId: null },
    );
    board.update(
      inCaptainChat.id,
      { status: "in_progress" },
      { kind: "user", agentId: null },
    );

    const payloads = (id: string) =>
      w.host.product.routines.store
        .triggerEventsOfRoutine(id)
        .map((event) => event.payload as Record<string, unknown>);
    await until(() => payloads(all.id).length === 2);
    expect(payloads(all.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "In group",
          groupId: group.id,
          groupName: "eng",
          groupKind: "group",
          creator: bob.id,
          creatorName: "Bob",
        }),
        expect.objectContaining({
          title: "In Captain's chat",
          groupId: captainConversationId,
          groupKind: "captain",
          creator: ada.id,
          creatorName: "Ada",
        }),
      ]),
    );
    expect(payloads(inGroup.id).map((p) => p.title)).toEqual(["In group"]);
    expect(payloads(inCaptain.id).map((p) => p.title)).toEqual([
      "In Captain's chat",
    ]);
    expect(payloads(byBob.id).map((p) => p.title)).toEqual(["In group"]);
  }, 30_000);
});
