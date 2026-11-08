/**
 * The conversation view and its tab label against a wire whose state the test sets: what shows
 * before the conversation arrives, when it is missing, when the host is too old, the messages
 * waiting their turn, the reply status line, and the tab's title and status mark.
 * Sending, stopping and the commands run against a real host in `view-host.test.tsx`.
 */
import type {
  AgentView,
  ConversationInfo,
  ConversationSummary,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { KeyBinding } from "../../src/config/types";
import type { WireClient, WireState } from "../../src/connection/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, plain } from "../ui-support/render";

vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

const ID = "c0nversation-one";
const SEND_OPS = ["conversations.send", "conversations.stop"];

function agent(id: string, name: string): AgentView {
  return { id, name } as AgentView;
}

function member(
  agentId: string,
  status: MemberView["status"] = "idle",
): MemberView {
  return { agentId, sessionId: `s-${agentId}`, lastSeq: 0, status };
}

function row(seq: number, patch: Partial<MessageView> = {}): MessageView {
  return {
    id: `m${seq}`,
    conversationId: ID,
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: `line ${seq}`,
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: seq,
    updatedAt: seq,
    ...patch,
  };
}

function info(patch: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id: ID,
    projectId: "p1",
    kind: "group",
    name: "Release notes",
    goal: "",
    decided: "",
    archived: false,
    stewardId: "a1",
    stewardOverrideId: null,
    noSteward: false,
    readSeq: 0,
    lastSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function summary(
  patch: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: ID,
    projectId: "p1",
    kind: "group",
    name: "Release notes",
    archived: false,
    stewardId: "a1",
    participants: [member("a1")],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const target = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 1,
});

interface World {
  rows?: MessageView[];
  held?: MessageView[];
  members?: MemberView[];
  agents?: AgentView[];
  list?: ConversationSummary[];
  /** Leave the conversation's own target out, as before the host answers. */
  undelivered?: boolean;
  missing?: boolean;
  ops?: string[];
}

/** A wire that never touches a network, counting subscriptions that are still held. */
function worldWire(world: World): WireClient & {
  held: Map<string, number>;
  calls: { op: string; args: unknown }[];
} {
  const rows = world.rows ?? [row(1)];
  const targets: WireState["targets"] = {
    agents: target({ list: world.agents ?? [agent("a1", "Ada")] }),
    conversations: target({ list: world.list ?? [summary()] }),
  };
  if (world.undelivered !== true && world.missing !== true) {
    targets[`conversations.${ID}`] = target({
      info: info({ lastSeq: rows.at(-1)?.seq ?? 0 }),
      members: world.members ?? [member("a1")],
      timeline: { messages: rows, hasMore: false, held: world.held ?? [] },
    });
  }
  const missingTargets: WireState["missing"] = {};
  if (world.missing === true) missingTargets[`conversations.${ID}`] = true;
  const store = createStore<WireState>(() => ({
    status: "open",
    ops: world.ops ?? SEND_OPS,
    mounted: [],
    targets,
    missing: missingTargets,
    error: undefined,
  }));
  const held = new Map<string, number>();
  const calls: { op: string; args: unknown }[] = [];
  return {
    store,
    held,
    calls,
    can: (op) => store.getState().ops.includes(op),
    // Answers nothing and changes nothing: the read mark stays where it was.
    call: async (name, action, args) => {
      calls.push({ op: `${name}.${action}`, args });
      return undefined as never;
    },
    subscribe: (name) => {
      held.set(name, (held.get(name) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.set(name, (held.get(name) ?? 1) - 1);
      };
    },
    onEvent: () => () => {},
  };
}

async function show(
  world: World,
  options: Parameters<typeof renderApp>[0] = {},
) {
  const wire = worldWire(world);
  const r = await renderApp({
    patch: { wire },
    state: { tabs: [{ kind: CONVERSATION_VIEW, id: ID }], activeTab: 0 },
    columns: 60,
    rows: 16,
    ...options,
  });
  open.push(r);
  await flush();
  return { r, wire };
}

/** The frame's lines, each without trailing spaces. */
const frameLines = (r: { lastFrame: () => string }) =>
  plain(r)
    .split("\n")
    .map((line) => line.trimEnd());

/** The composer while empty: its prompt and hint. A user's row starts with the same mark. */
const COMPOSER_HINT = "› Write a message";

describe("before and without the conversation", () => {
  it("says it is loading until the conversation's target arrives, and offers no input", async () => {
    const { r } = await show({ undelivered: true });
    const lines = frameLines(r);
    expect(lines[0]).toBe("Loading…");
    expect(lines.some((line) => line.startsWith(COMPOSER_HINT))).toBe(false);
  });

  it("says the conversation is not there when the host answered target:missing, and offers no input", async () => {
    const { r } = await show({ missing: true });
    const lines = frameLines(r);
    expect(lines[0]).toBe("This conversation was not found");
    expect(lines.some((line) => line.startsWith(COMPOSER_HINT))).toBe(false);
    expect(plain(r)).not.toContain("Loading…");
  });

  it("draws the rows but no input when the host cannot take a message, and says why", async () => {
    const { r } = await show({
      rows: [row(1, { text: "hello there" })],
      ops: ["conversations.stop"],
    });
    const lines = frameLines(r);
    expect(plain(r)).toContain("hello there");
    expect(lines).toContain("This host is too old to send messages from here");
    expect(lines.some((line) => line.startsWith(COMPOSER_HINT))).toBe(false);
  });

  it("offers the input when the host takes messages", async () => {
    const { r } = await show({ rows: [row(1, { text: "hello there" })] });
    const lines = frameLines(r);
    expect(lines.some((line) => line.startsWith(COMPOSER_HINT))).toBe(true);
    expect(plain(r)).not.toContain("too old");
  });

  it("speaks Chinese when the settings say so", async () => {
    const { r } = await show(
      { missing: true },
      { config: testConfig({ locale: "zh" }) },
    );
    expect(frameLines(r)[0]).toBe("找不到这个对话");
  });
});

describe("messages waiting their turn", () => {
  it("lists each held message's first line, muted, above the input and below the transcript", async () => {
    const { r } = await show({
      rows: [row(1, { text: "earlier words" })],
      held: [
        row(2, { text: "second thought\nwith more lines" }),
        row(3, { text: "third" }),
      ],
    });
    const lines = frameLines(r);
    const second = lines.indexOf("⧗ second thought");
    const third = lines.indexOf("⧗ third");
    const input = lines.findIndex((line) => line.startsWith(COMPOSER_HINT));
    const transcript = lines.findIndex((line) =>
      line.includes("earlier words"),
    );
    expect(second).toBeGreaterThan(transcript);
    expect(third).toBe(second + 1);
    // The input's upper rule sits between the last held message and the input.
    expect(lines[third + 1]).toMatch(/^─+$/);
    expect(input).toBe(third + 2);
    expect(plain(r)).not.toContain("with more lines");
    const raw = r.lastFrame().split("\n");
    expect(raw[second]).toContain("\u001B[90m");
  });

  it("cuts a held message to the width", async () => {
    const long = "word ".repeat(40).trim();
    const { r } = await show({ held: [row(2, { text: long })] });
    const line = frameLines(r).find((l) => l.startsWith("⧗ "));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(60);
    expect(line!.length).toBeGreaterThan(50);
    expect(line).toMatch(/…$/);
  });
});

describe("reply status line", () => {
  // Enough rows to fill the transcript, so its last row is never blank.
  const replying = (status: MessageView["status"]) => ({
    rows: [
      ...Array.from({ length: 14 }, (_, i) => row(i + 1)),
      row(15, { text: "please answer" }),
      row(16, { author: "agent", agentId: "a1", text: "", status }),
    ],
    members: [member("a1", status === "done" ? "idle" : "working")],
  });

  it("names who is replying and the keys that stop and steer, muted, right above the input", async () => {
    const { r } = await show(replying("working"));
    const lines = frameLines(r);
    const status = lines.indexOf(
      "Ada is replying · escape to stop · tab to steer",
    );
    const input = lines.findIndex((line) => line.startsWith(COMPOSER_HINT));
    expect(status).toBeGreaterThan(-1);
    // The input's upper rule sits between the status line and the input.
    expect(lines[status + 1]).toMatch(/^─+$/);
    expect(input).toBe(status + 2);
    expect(r.lastFrame().split("\n")[status]).toContain("\u001B[90m");
  });

  it.each(["waiting_for_input", "stopping"] as const)(
    "shows while the reply is %s",
    async (status) => {
      const { r } = await show(replying(status));
      expect(plain(r)).toContain("Ada is replying");
    },
  );

  it.each(["queued", "done", "stopped", "failed"] as const)(
    "takes no row while the reply is %s",
    async (status) => {
      const { r } = await show(replying(status));
      expect(plain(r)).not.toContain("is replying");
      const lines = frameLines(r);
      const input = lines.findIndex((line) => line.startsWith(COMPOSER_HINT));
      // The row above the input's upper rule belongs to the transcript, not to an empty status line.
      expect(input).toBeGreaterThan(1);
      expect(lines[input - 1]).toMatch(/^─+$/);
      expect(lines[input - 2]).not.toBe("");
    },
  );

  it("names the keys as the settings bind them", async () => {
    const config = testConfig();
    const bind = (key: string, mods: Partial<KeyBinding> = {}): KeyBinding => ({
      key,
      ctrl: false,
      alt: false,
      shift: false,
      ...mods,
    });
    const { r } = await show(replying("working"), {
      config: {
        ...config,
        keybindings: {
          ...config.keybindings,
          "reply.stop": [bind("x", { ctrl: true }), bind("escape")],
          "message.steer": [bind("s", { alt: true })],
        },
      },
    });
    expect(plain(r)).toContain(
      "Ada is replying · ctrl+x to stop · alt+s to steer",
    );
  });

  it("names every agent replying at once", async () => {
    const { r } = await show({
      rows: [
        row(1, { text: "both of you" }),
        row(2, { author: "agent", agentId: "a1", status: "working", text: "" }),
        row(3, { author: "agent", agentId: "a2", status: "working", text: "" }),
      ],
      members: [member("a1", "working"), member("a2", "working")],
      agents: [agent("a1", "Ada"), agent("a2", "Bob")],
    });
    expect(plain(r)).toContain("Ada, Bob are replying");
  });
});

describe("tab label", () => {
  it("is the conversation's name from the list", async () => {
    const { r } = await show({});
    expect(frameLines(r).at(-1)).toContain("1:Release notes");
  });

  it("is the start of the id while the list does not have it", async () => {
    const { r } = await show({ list: [] });
    expect(frameLines(r).at(-1)).toContain(`1:${ID.slice(0, 8)}`);
    expect(frameLines(r).at(-1)).not.toContain(`1:${ID.slice(0, 9)}`);
  });

  it.each([
    [["waiting_for_input", "working"], "!"],
    [["idle", "working"], "●"],
    [["queued"], "●"],
    [["stopping"], "●"],
  ] as const)("with members %j it marks the tab %s", async (statuses, mark) => {
    const participants = statuses.map((status, i) => member(`a${i}`, status));
    const { r } = await show({ list: [summary({ participants })] });
    expect(frameLines(r).at(-1)).toContain(`1:Release notes ${mark}`);
  });

  it("draws no mark while nobody is answering", async () => {
    const { r } = await show({
      list: [summary({ participants: [member("a1"), member("a2")] })],
    });
    const bar = frameLines(r).at(-1)!;
    expect(bar).toContain("1:Release notes");
    expect(bar).not.toMatch(/Release notes [!●✓✗]/);
  });
});

describe("the conversation list", () => {
  it("is followed while the shell shows, also with no conversation open, so names and new conversations stay current", async () => {
    const wire = worldWire({});
    const r = await renderApp({
      patch: { wire },
      state: { tabs: [], activeTab: undefined },
    });
    open.push(r);
    await flush();
    expect(wire.held.get("conversations")).toBe(1);
    r.unmount();
    expect(wire.held.get("conversations")).toBe(0);
  });
});

describe("the read mark", () => {
  const many = Array.from({ length: 30 }, (_, i) => row(i + 1));
  const reads = (wire: { calls: { op: string; args: unknown }[] }) =>
    wire.calls.filter((c) => c.op === "conversations.read").map((c) => c.args);

  it("is asked once per row, however often the view comes back to the bottom or to the front", async () => {
    const wire = worldWire({
      rows: many,
      ops: [...SEND_OPS, "conversations.read"],
    });
    const r = await renderApp({
      patch: { wire },
      state: {
        tabs: [
          { kind: CONVERSATION_VIEW, id: ID },
          { kind: "elsewhere", id: "x" },
        ],
        activeTab: 0,
      },
      columns: 60,
      rows: 16,
    });
    open.push(r);
    await flush();
    expect(reads(wire)).toEqual([{ conversationId: ID, seq: 30 }]);
    await r.press("[5~"); // page up
    await r.press("[1;5F"); // to the bottom
    await r.press(KEYS.altRight);
    await r.press(KEYS.altLeft);
    await flush();
    expect(reads(wire)).toEqual([{ conversationId: ID, seq: 30 }]);
  });

  it("is not asked of a host without conversations.read", async () => {
    const { wire } = await show({ rows: many });
    expect(reads(wire)).toEqual([]);
  });
});

describe("leaving the tab", () => {
  it("lets go of the view's share of the conversation's subscription while another tab is in front, and takes it again on return", async () => {
    const wire = worldWire({});
    const r = await renderApp({
      patch: { wire },
      state: {
        tabs: [
          { kind: CONVERSATION_VIEW, id: ID },
          { kind: "elsewhere", id: "x" },
        ],
        activeTab: 0,
      },
      columns: 60,
      rows: 16,
    });
    open.push(r);
    await flush();
    // The view holds one share while in front; the tab's label holds the other while it is open.
    const subscribed = () => wire.held.get(`conversations.${ID}`) ?? 0;
    expect(subscribed()).toBe(2);
    await r.press(KEYS.altRight);
    expect(subscribed()).toBe(1);
    await r.press(KEYS.altLeft);
    expect(subscribed()).toBe(2);
  });
});
