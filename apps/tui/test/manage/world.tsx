/**
 * The conversation host world of the view tests, with what the management tests add: the
 * interface's wire can be told to fail an op as the host would, or to hold an op's reply until
 * the test lets it go; the test reads the eager agents, projects and machines lists (following
 * them from its first read on); and the status area and the layers can be read off the screen.
 */
import type {
  AgentView,
  ConversationInfo,
  ConversationSummary,
  MachineView,
  ProjectView,
} from "@eta/client-contracts";
import type { TuiState } from "../../src/config/types";
import type { WireClient } from "../../src/connection/types";
import type { Asked, Respond } from "../conversation/view-host-world";
import type { RenderedApp } from "../ui-support/app";
import { afterEach } from "vitest";
import { WireError } from "../../src/connection/wire";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { hostWorld } from "../conversation/view-host-world";
import { baseUrl } from "../support/host";
import { until } from "../support/temp";
import { renderApp } from "../ui-support/app";
import { KEYS, plain } from "../ui-support/render";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A reply held back until `release` lets it through. */
export interface Held {
  /** Resolves once the interface made the call. */
  asked: Promise<void>;
  release: () => void;
}

type Interceptor =
  | { kind: "fail"; message: string; times: number }
  | { kind: "hold"; gate: Promise<void>; markAsked: () => void }
  | { kind: "answer"; answer: (args: unknown) => Promise<unknown> };

/** Wraps the recording wire so a test can fail or hold any op. */
function interceptable(wire: WireClient & { asked: Asked[] }) {
  const rules = new Map<string, Interceptor>();
  const client: WireClient & { asked: Asked[] } = {
    store: wire.store,
    asked: wire.asked,
    can: (op) => wire.can(op),
    subscribe: (target) => wire.subscribe(target),
    onEvent: (target, listener) => wire.onEvent(target, listener),
    call: async <T,>(
      target: string,
      action: string,
      args?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<T> => {
      const op = `${target}.${action}`;
      const rule = rules.get(op);
      if (rule?.kind === "fail" && rule.times > 0) {
        rule.times -= 1;
        wire.asked.push({ op, args: (args ?? {}) as Record<string, unknown> });
        throw new WireError("server", rule.message);
      }
      if (rule?.kind === "answer") {
        wire.asked.push({ op, args: (args ?? {}) as Record<string, unknown> });
        return (await rule.answer(args)) as T;
      }
      if (rule?.kind === "hold") {
        rules.delete(op);
        const result = wire.call<T>(target, action, args, options);
        rule.markAsked();
        await rule.gate;
        return result;
      }
      return wire.call<T>(target, action, args, options);
    },
  };
  return {
    client,
    /** The next `times` calls of `op` fail with `message`, as a host refusal does. */
    failOn: (op: string, message: string, times = 1) => {
      rules.set(op, { kind: "fail", message, times });
    },
    /** Every call of `op` is answered by `answer` instead of the host; it throws to refuse. */
    answerOn: (op: string, answer: (args: unknown) => Promise<unknown>) => {
      rules.set(op, { kind: "answer", answer });
    },
    /** The next call of `op` goes to the host, and its reply waits for `release`. */
    holdOn: (op: string): Held => {
      let release = () => {};
      let markAsked = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const asked = new Promise<void>((resolve) => {
        markAsked = resolve;
      });
      rules.set(op, { kind: "hold", gate, markAsked });
      return { asked, release };
    },
  };
}

export async function manageWorld(
  respond: Respond = () => {
    throw new Error("nobody should be asked");
  },
) {
  const world = await hostWorld(respond);
  // Followed only once a test reads them: the interface has to follow what it needs itself.
  const followed = new Set<string>();
  const follow = (target: string) => {
    if (followed.has(target)) return;
    followed.add(target);
    cleanups.push(world.raw.subscribe(target));
  };
  const wire = interceptable(world.wire);

  const section = <T,>(target: string, name: string): T | undefined =>
    world.raw.store.getState().targets[target]?.sections[name] as T | undefined;
  const conversations = () =>
    section<ConversationSummary[]>("conversations", "list") ?? [];
  const projects = () => {
    follow("projects");
    return section<ProjectView[]>("projects", "list") ?? [];
  };
  const agents = () => {
    follow("agents");
    return section<AgentView[]>("agents", "list") ?? [];
  };
  const machines = () => {
    follow("machines");
    return section<MachineView[]>("machines", "list") ?? [];
  };

  /** The conversation's own facts as the host has them, following its target meanwhile. */
  const infoOf = async (id: string): Promise<ConversationInfo> => {
    const target = `conversations.${id}`;
    const release = world.raw.subscribe(target);
    cleanups.push(release);
    await until(
      () => section<ConversationInfo>(target, "info") !== undefined,
      10_000,
      `the info of ${id}`,
    );
    return section<ConversationInfo>(target, "info")!;
  };

  const show = async (
    state: TuiState,
    size = { columns: 100, rows: 30 },
  ): Promise<RenderedApp> => {
    // Connected to the real host's address, so addresses built from it can be fetched.
    const r = await renderApp({
      phase: { name: "connected", url: baseUrl(world.host), temporary: false },
      patch: { wire: wire.client },
      state,
      ...size,
    });
    cleanups.push(() => r.unmount());
    return r;
  };
  const showFront = (id: string, size?: { columns: number; rows: number }) =>
    show({ tabs: [{ kind: CONVERSATION_VIEW, id }], activeTab: 0 }, size);
  const showHome = (size?: { columns: number; rows: number }) =>
    show({ tabs: [], activeTab: undefined }, size);

  /** Waits until the wire the interface reads holds `count` agents, so a command sees them all. */
  const agentsArrived = (count: number) =>
    until(
      () =>
        (
          wire.client.store.getState().targets.agents?.sections.list as
            | unknown[]
            | undefined
        )?.length === count,
      10_000,
      `${count} agents on the interface's wire`,
    );

  return {
    ...world,
    wire: wire.client,
    failOn: wire.failOn,
    holdOn: wire.holdOn,
    answerOn: wire.answerOn,
    conversations,
    projects,
    agents,
    machines,
    infoOf,
    show,
    showFront,
    showHome,
    agentsArrived,
  };
}

/** The status area: the row above the tab bar. */
export const statusLine = (r: RenderedApp) => plain(r).split("\n").at(-2) ?? "";

/** The tab bar: the last row. */
export const tabBar = (r: RenderedApp) => plain(r).split("\n").at(-1) ?? "";

export async function enter(r: RenderedApp, line: string): Promise<void> {
  await r.type(line);
  await r.press(KEYS.enter);
}

/** The calls of ops starting with `prefix` the interface made. */
export const askedStarting = (
  wire: { asked: Asked[] },
  prefix: string,
): Asked[] => wire.asked.filter((asked) => asked.op.startsWith(prefix));
