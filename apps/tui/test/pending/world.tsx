/**
 * A real host in this process with two agents in two conversations, the TUI's own wire to it, and
 * the whole interface drawn in memory on that wire: what the waiting items are tested on. Agents
 * ask questions with `ask_user` and propose tasks with `draft_task` as each test scripts them; the
 * test confirms drafts and moves tasks the way the user does elsewhere, over its own connection.
 *
 * The interface's wire writes down every call, and a test can hold a call or a subscription back,
 * or make a call fail, to see the interface between asking and hearing back.
 */
import type {
  AgentView,
  BoardTaskDetail,
  BoardTaskView,
  ConversationSummary,
  HistoryResult,
  InteractionView,
  ProjectView,
  SendResult,
} from "@eta/client-contracts";
import type { HANG, Request } from "../../../eta/test/support/models";
import type { TuiConfig, TuiState } from "../../src/config/types";
import type { WireClient } from "../../src/connection/types";
import type { Extension, ShellContext } from "../../src/extensions/types";
import type { RenderedApp } from "../ui-support/app";
import { afterEach } from "vitest";
import { call, say, scriptedModels } from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { Wire } from "../../src/connection/wire";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { useRegistry, useShell } from "../../src/extensions/react";
import { baseUrl, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { flush, plain } from "../ui-support/render";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** One call the interface made, its arguments as sent. */
export interface Asked {
  op: string;
  args: Record<string, unknown>;
}

/** A call the test holds back: it reaches the host (or fails) only when the test lets it go. */
export interface Held {
  op: string;
  args: Record<string, unknown>;
  /** Send it to the host now. */
  release: () => void;
  /** Fail it with this message, never sending it. */
  fail: (message: string) => void;
}

export type Behaviour = (
  request: Request,
) => ReturnType<typeof say> | typeof HANG;

/** The interface's wire: records calls, and holds back what the test asks it to. */
export interface TestWire extends WireClient {
  asked: Asked[];
  /** Ops the host is to look as if it lacks. */
  lacking: Set<string>;
  /** Calls of these ops wait in `held` until released or failed. */
  holding: Set<string>;
  held: Held[];
  /** Subscriptions to these targets start only when `releaseSubscriptions` runs. */
  holdingTargets: Set<string>;
  releaseSubscriptions: () => void;
  /** Every target the interface subscribed to and has not released, with how many times. */
  subscribed: Map<string, number>;
}

function testWire(wire: Wire): TestWire {
  const asked: Asked[] = [];
  const held: Held[] = [];
  const lacking = new Set<string>();
  const holding = new Set<string>();
  const holdingTargets = new Set<string>();
  const waitingSubscriptions: (() => void)[] = [];
  const subscribed = new Map<string, number>();
  const count = (target: string, by: number) => {
    const next = (subscribed.get(target) ?? 0) + by;
    if (next === 0) subscribed.delete(target);
    else subscribed.set(target, next);
  };
  return {
    store: wire.store,
    asked,
    lacking,
    holding,
    held,
    holdingTargets,
    subscribed,
    releaseSubscriptions: () => {
      for (const start of waitingSubscriptions.splice(0)) start();
    },
    can: (op) => !lacking.has(op) && wire.can(op),
    call: <T,>(
      target: string,
      action: string,
      args?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<T> => {
      const op = `${target}.${action}`;
      const record = (args ?? {}) as Record<string, unknown>;
      asked.push({ op, args: record });
      if (!holding.has(op)) return wire.call<T>(target, action, args, options);
      return new Promise<T>((resolve, reject) => {
        held.push({
          op,
          args: record,
          release: () =>
            wire.call<T>(target, action, args, options).then(resolve, reject),
          fail: (message) => reject(new Error(message)),
        });
      });
    },
    subscribe: (target) => {
      count(target, 1);
      let release: (() => void) | undefined;
      let released = false;
      const start = () => {
        if (!released) release = wire.subscribe(target);
      };
      if (holdingTargets.has(target)) waitingSubscriptions.push(start);
      else start();
      return () => {
        if (released) return;
        released = true;
        count(target, -1);
        release?.();
      };
    },
    onEvent: (target, listener) => wire.onEvent(target, listener),
  };
}

export async function pendingWorld() {
  const behaviours = new Map<string, Behaviour>();
  const { models, requests } = scriptedModels((request) => {
    const behaviour = behaviours.get(request.agent ?? "");
    return behaviour ? behaviour(request) : say("ok");
  });
  // Task runs start a shell, which is not there on every machine these tests run on; the board
  // is what is tested, so a confirmed task waits where the test moves it.
  const host = await testHost({
    overrides: { models: models as never, tasks: { runs: false } },
  });
  const raw = new Wire({ url: wireUrl(baseUrl(host)) });
  cleanups.push(() => raw.close());
  raw.connect();
  await until(() => raw.store.getState().status === "open", 20_000, "hello");
  // The test follows what it reads of the host on its own, apart from the interface.
  for (const target of ["conversations", "inbox", "tasks", "agents"])
    cleanups.push(raw.subscribe(target));
  const wire = testWire(raw);

  const ask = <T,>(target: string, action: string, args: unknown) =>
    raw.call<T>(target, action, args);
  const agent = async (name: string) =>
    (await ask<{ agent: AgentView }>("agents", "create", { name })).agent;
  const project = async (stewardId: string) =>
    (
      await ask<{ project: ProjectView }>("projects", "create", {
        path: await tempDir("eta-tui-project-"),
        stewardId,
      })
    ).project;
  const conversation = async (
    projectId: string,
    agentIds: string[],
    name: string,
  ) =>
    (
      await ask<{ conversation: ConversationSummary }>(
        "conversations",
        "create",
        { projectId, agentIds, name },
      )
    ).conversation;
  const send = (conversationId: string, text: string) =>
    ask<SendResult>("conversations", "send", { conversationId, text });

  const listOf = <T,>(target: string): T[] =>
    (raw.store.getState().targets[target]?.sections.list as T[] | undefined) ??
    [];
  const interactions = () => listOf<InteractionView>("inbox");
  const interaction = (id: string) => interactions().find((i) => i.id === id);
  const tasks = () => listOf<BoardTaskView>("tasks");
  const taskView = (id: string) => tasks().find((t) => t.id === id);
  const conversations = () => listOf<ConversationSummary>("conversations");

  /** An agent and a conversation it stewards, alone in its project. */
  const room = async (agentName: string, conversationName: string) => {
    const member = await agent(agentName);
    const place = await project(member.id);
    const group = await conversation(place.id, [member.id], conversationName);
    return { agent: member, group };
  };

  /**
   * `agentName` asks `question` the next time it is woken in `conversationId`, and repeats the
   * answer after. Wakes it and waits for the question to be pending on the host.
   */
  const askIn = async (
    agentName: string,
    conversationId: string,
    question: string,
    options: { choices?: string[]; multi?: boolean } = {},
  ): Promise<InteractionView> => {
    behaviours.set(agentName, (request) =>
      request.lastRole === "toolResult"
        ? say(`Told: ${request.last}`)
        : call("ask_user", {
            question,
            ...(options.choices === undefined
              ? {}
              : { options: options.choices.map((title) => ({ title })) }),
            ...(options.multi === undefined
              ? {}
              : { allowMultiple: options.multi }),
          }),
    );
    await send(conversationId, `ask ${question}`);
    let found: InteractionView | undefined;
    await until(
      () => {
        found = interactions().find(
          (i) => i.status === "pending" && i.prompt === question,
        );
        return found !== undefined;
      },
      20_000,
      `the question ${question}`,
    );
    return found!;
  };

  /** Moves a task the way the user does on the board. */
  const moveTask = async (taskId: string, status: BoardTaskView["status"]) => {
    await ask("tasks", "update", { taskId, status });
    await until(
      () => taskView(taskId)?.status === status,
      20_000,
      `the task at ${status}`,
    );
  };

  /**
   * `agentName` proposes a task in `conversationId` with `draft_task`, the test confirms it, the
   * agent comments `summary` on it as an executor reports, and the user moves it to review.
   */
  const reviewTask = async (
    agentName: string,
    conversationId: string,
    title: string,
    goal: string,
    summary = "Did it.",
  ): Promise<BoardTaskDetail> => {
    behaviours.set(agentName, (request) => {
      if (request.lastRole === "toolResult") return say("Drafted.");
      return request.last.includes(`draft ${title}`)
        ? call("draft_task", { title, goal, acceptance: "It works" })
        : say("ok");
    });
    await send(conversationId, `draft ${title}`);
    let draftId: string | undefined;
    await until(
      async () => {
        const { messages } = await ask<HistoryResult>(
          "conversations",
          "history",
          { conversationId, limit: 100 },
        );
        draftId = messages.find(
          (row) => row.kind === "task_draft" && row.data.title === title,
        )?.id;
        return draftId !== undefined;
      },
      20_000,
      `the draft ${title}`,
    );
    const { task } = await ask<{ task: BoardTaskDetail }>(
      "tasks",
      "confirmDraft",
      { conversationId, messageId: draftId },
    );
    // What an executor's `comment_task` does, without a run to do it in.
    host.product.board.comment(task.id, summary, {
      kind: "agent",
      agentId: task.createdBy.agentId,
    });
    await moveTask(task.id, "in_review");
    return task;
  };

  /** Answers a question over the test's own connection, as another client would. */
  const answerElsewhere = async (id: string, choice?: string) => {
    await ask("inbox", "answer", {
      id,
      response:
        choice === undefined
          ? { kind: "none" }
          : { kind: "selection", selections: [choice] },
    });
    await until(
      () => interaction(id)?.status !== "pending",
      20_000,
      "the question settled",
    );
  };

  const show = async (
    state: TuiState = { tabs: [], activeTab: undefined },
    options: {
      columns?: number;
      rows?: number;
      config?: TuiConfig;
      extensions?: Extension[];
    } = {},
  ) => {
    const r = await renderApp({
      patch: { wire },
      state,
      extensions: options.extensions ?? [],
      columns: options.columns ?? 100,
      rows: options.rows ?? 30,
      config: options.config ?? testConfig(),
    });
    cleanups.push(() => r.unmount());
    return r;
  };
  const showConversations = (
    ids: string[],
    active = 0,
    options?: Parameters<typeof show>[1],
  ) =>
    show(
      {
        tabs: ids.map((id) => ({ kind: CONVERSATION_VIEW, id })),
        activeTab: active,
      },
      options,
    );

  return {
    host,
    raw,
    wire,
    requests,
    behaviours,
    agent,
    project,
    conversation,
    room,
    send,
    ask,
    interactions,
    interaction,
    tasks,
    taskView,
    conversations,
    askIn,
    reviewTask,
    moveTask,
    answerElsewhere,
    show,
    showConversations,
  };
}

export type PendingWorld = Awaited<ReturnType<typeof pendingWorld>>;

/** Ada stewards "Ada room" and Ben stewards "Ben room". */
export async function twoRooms() {
  const world = await pendingWorld();
  const ada = await world.room("Ada", "Ada room");
  const ben = await world.room("Ben", "Ben room");
  return { ...world, ada, ben };
}

export function screenShows(
  r: RenderedApp,
  text: string | ((screen: string) => boolean),
  timeoutMs = 20_000,
): Promise<void> {
  const holds =
    typeof text === "string" ? (s: string) => s.includes(text) : text;
  return until(
    async () => {
      await flush();
      return holds(plain(r));
    },
    timeoutMs,
    `the screen to show ${String(text)}`,
  );
}

/** The last line of the screen: the tab bar. */
export const tabBar = (r: RenderedApp) => plain(r).split("\n").at(-1) ?? "";

/** The calls of one op the interface made, oldest first. */
export const askedFor = (wire: { asked: Asked[] }, op: string) =>
  wire.asked.filter((asked) => asked.op === op).map((asked) => asked.args);

/**
 * A feature that only watches: what the pending entry's attention hook says on every draw, and
 * the shell's context, to select the entry the way the tab bar does.
 */
export function probe() {
  const attention: boolean[] = [];
  let ctx: ShellContext | undefined;
  function Watch() {
    ctx = useShell();
    const pinned = useRegistry().pinnedTabs.find((p) => p.id === "pending");
    attention.push(pinned?.useAttention?.() ?? false);
    return null;
  }
  const extension: Extension = { id: "zz-probe", Background: Watch };
  return {
    extension,
    attention,
    ctx: () => {
      if (!ctx) throw new Error("the probe is not mounted");
      return ctx;
    },
  };
}

export const PENDING_KEYS = {
  openConversation: "\u001Bo",
  review: "\u0012",
  space: " ",
  pageDown: "\u001B[6~",
  pageUp: "\u001B[5~",
} as const;
