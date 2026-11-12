/**
 * A reply's steps folded on screen, in the whole interface against a wire whose state the test
 * sets: what shows folded, Ctrl+O and the toggle key, the selection's space and `c` on the steps
 * line, the search, coming back to the tab, and the `transcript.toolCalls` setting with a reload.
 */
import type {
  AgentView,
  ConversationInfo,
  MessageView,
} from "@eta/client-contracts";
import type { LoadedConfig, TuiConfig } from "../../src/config/types";
import type { WireClient, WireState } from "../../src/connection/types";
import { Buffer } from "node:buffer";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { renderApp } from "../ui-support/app";
import { loaded, testConfig } from "../ui-support/config";
import { flush, KEYS, plain, realDelay } from "../ui-support/render";

vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ID = "c1";
const KEY = {
  top: "\u001B[1;5H",
  select: "\u001Bv",
  search: "\u0006",
  expandAll: "\u000F",
  toggleTurn: KEYS.alt("e"),
};

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

/** A finished reply that thought, ran two commands (the second failed), and then said `words`. */
function workedReply(seq: number, name: string, words: string): MessageView {
  return row(seq, {
    author: "agent",
    agentId: "a1",
    text: words,
    thinking: `${name} thought`,
    data: {
      activity: [
        {
          id: `${name}1`,
          name: "bash",
          input: { command: `${name} first` },
          output: `${name} out one`,
          status: "completed",
        },
        {
          id: `${name}2`,
          name: "bash",
          input: { command: `${name} second` },
          output: `${name} went wrong`,
          status: "failed",
        },
      ],
    },
  });
}

const target = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 1,
});

function sceneWire(rows: MessageView[]): WireClient {
  const last = rows.at(-1)?.seq ?? 0;
  const info = {
    id: ID,
    projectId: "p1",
    kind: "direct",
    name: "Notes",
    readSeq: last,
    lastSeq: last,
  } as ConversationInfo;
  const store = createStore<WireState>(() => ({
    status: "open",
    ops: ["conversations.send", "conversations.stop"],
    mounted: [],
    targets: {
      agents: target({ list: [{ id: "a1", name: "Ada" } as AgentView] }),
      conversations: target({
        list: [{ id: ID, name: "Notes", participants: [] } as never],
      }),
      [`conversations.${ID}`]: target({
        info,
        members: [
          { agentId: "a1", sessionId: "s1", lastSeq: 0, status: "idle" },
        ],
        timeline: { messages: rows, hasMore: false, held: [] },
      }),
    },
    missing: {},
    error: undefined,
  }));
  return {
    store,
    can: (op) => store.getState().ops.includes(op),
    call: async () => undefined as never,
    subscribe: () => () => {},
    onEvent: () => () => {},
  };
}

async function show(
  rows: MessageView[],
  options: {
    config?: TuiConfig;
    rows?: number;
    tabs?: number;
    loadConfig?: () => Promise<LoadedConfig>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const tabs = [
    { kind: CONVERSATION_VIEW, id: ID },
    ...(options.tabs === 2 ? [{ kind: "elsewhere", id: "x" }] : []),
  ];
  const r = await renderApp({
    patch: { wire: sceneWire(rows) },
    state: { tabs, activeTab: 0 },
    columns: 60,
    rows: options.rows ?? 30,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.loadConfig === undefined
      ? {}
      : { loadConfig: options.loadConfig }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  open.push(r);
  await settle();
  return r;
}

/** The drawing happens after a render and comes back in the next; this waits for both. */
async function settle() {
  await flush();
  await realDelay(50);
  await flush();
}

async function press(
  r: { press: (data: string) => Promise<void> },
  key: string,
) {
  await r.press(key);
  await settle();
}

const scene = () => [
  row(1, { text: "go" }),
  workedReply(2, "ada", "final words"),
];

/** What shows of the reply's steps when they are folded, and when they are not. */
function expectFolded(screen: string) {
  expect(screen).toContain("▸ Used 2 tools, 1 failed");
  expect(screen).toContain("final words");
  expect(screen).not.toContain("$ ada first");
  expect(screen).not.toContain("$ ada second");
  expect(screen).not.toContain("Thinking");
}
function expectUnfolded(screen: string) {
  expect(screen).toContain("▾ Used 2 tools, 1 failed");
  expect(screen).toContain("$ ada first");
  expect(screen).toContain("$ ada second");
  expect(screen).toContain("final words");
}

describe("folded", () => {
  it("shows one line for the steps and the reply's last words, nothing of the calls", async () => {
    const r = await show(scene());
    expectFolded(plain(r));
    const lines = plain(r).split("\n");
    const steps = lines.findIndex((line) => line.includes("Used 2 tools"));
    const words = lines.findIndex((line) => line.includes("final words"));
    expect(steps).toBeGreaterThan(-1);
    expect(words).toBeGreaterThan(steps);
  });

  it("says it in Chinese", async () => {
    const r = await show(scene(), { config: testConfig({ locale: "zh" }) });
    expect(plain(r)).toContain("▸ 调用了 2 个工具，1 个失败");
  });

  it("draws the failures in the error colour and the rest muted", async () => {
    const r = await show(scene());
    const line = r
      .lastFrame()
      .split("\n")
      .find((one) => one.includes("Used 2 tools"))!;
    expect(line).toContain("\u001B[31m1 failed");
    expect(line).toContain("\u001B[90m");
  });

  it("is not found by the search", async () => {
    const r = await show(scene());
    await press(r, KEY.search);
    await r.type("ada out one");
    await settle();
    expect(plain(r)).toContain("No matches");
  });
});

describe("unfolding", () => {
  it("unfolds the steps with everything else on Ctrl+O, and folds them back", async () => {
    const r = await show(scene());
    await press(r, KEY.expandAll);
    expectUnfolded(plain(r));
    expect(plain(r)).toContain("ada thought");
    await press(r, KEY.expandAll);
    expectFolded(plain(r));
  });

  it("the toggle key unfolds the reply's steps with each step folded as before, and folds them back", async () => {
    const r = await show(scene());
    await press(r, KEY.toggleTurn);
    expectUnfolded(plain(r));
    expect(plain(r)).toContain("∴ Thinking · 1 line");
    expect(plain(r)).not.toContain("ada thought");
    await press(r, KEY.toggleTurn);
    expectFolded(plain(r));
  });

  it("the toggle key picks the lower of two steps lines on screen", async () => {
    const r = await show([
      row(1, { text: "go" }),
      workedReply(2, "ada", "first words"),
      row(3, { text: "again" }),
      workedReply(4, "bob", "second words"),
    ]);
    await press(r, KEY.toggleTurn);
    expect(plain(r)).toContain("$ bob first");
    expect(plain(r)).not.toContain("$ ada first");
  });

  it("the toggle key unfolds the newest reply's steps when none is on screen", async () => {
    const r = await show(
      [
        row(1, { text: "go" }),
        workedReply(2, "ada", "first words"),
        row(3, { text: "again" }),
        workedReply(4, "bob", "second words"),
        ...Array.from({ length: 30 }, (_, i) => row(5 + i)),
      ],
      { rows: 16 },
    );
    expect(plain(r)).not.toContain("Used 2 tools");
    await press(r, KEY.toggleTurn);
    await press(r, KEY.top);
    const screen = plain(r);
    expect(screen).toContain("▸ Used 2 tools, 1 failed");
    expect(screen).toContain("▾ Used 2 tools, 1 failed");
    expect(screen.indexOf("▸ Used")).toBeLessThan(screen.indexOf("▾ Used"));
    expect(screen).not.toContain("$ ada first");
  });

  it("stays unfolded after the tab is left and come back to", async () => {
    const r = await show(scene(), { tabs: 2 });
    await press(r, KEY.toggleTurn);
    expectUnfolded(plain(r));
    await press(r, KEYS.altRight);
    await press(r, KEYS.altLeft);
    expectUnfolded(plain(r));
  });
});

describe("the selection on the steps line", () => {
  // The transcript's last lines: the steps line, a blank line, the reply's words.
  async function onStepsLine() {
    const r = await show(scene());
    await press(r, KEY.select);
    await press(r, KEYS.up);
    await press(r, KEYS.up);
    return r;
  }

  it("space unfolds and folds the reply's steps", async () => {
    const r = await onStepsLine();
    await press(r, " ");
    expectUnfolded(plain(r));
    await press(r, " ");
    expectFolded(plain(r));
  });

  it("c copies every step as written, a blank line between steps", async () => {
    vi.stubEnv("TMUX", "");
    const written: string[] = [];
    const r = await onStepsLine();
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      written.push(String(data));
      return true;
    });
    await press(r, "c");
    const source = [
      "ada thought",
      "ada first\nada out one",
      "ada second\nada went wrong",
    ].join("\n\n");
    const base64 = Buffer.from(source, "utf8").toString("base64");
    expect(written).toContain(`\u001B]52;c;${base64}\u0007`);
    expect(plain(r)).toContain("Copied");
  });
});

describe("the toolCalls setting", () => {
  const expanded = () => testConfig({ transcript: { toolCalls: "expanded" } });

  it("expanded draws every step as its own item and no steps line", async () => {
    const r = await show(scene(), { config: expanded() });
    const screen = plain(r);
    expect(screen).toContain("$ ada first");
    expect(screen).toContain("$ ada second");
    expect(screen).toContain("∴ Thinking · 1 line");
    expect(screen).toContain("final words");
    expect(screen).not.toContain("Used 2 tools");
    expect(screen).not.toContain("▸");
  });

  it("takes effect when the settings are reloaded, either way", async () => {
    let next = loaded(expanded());
    const r = await show(scene(), {
      env: { EDITOR: "fake-ed" },
      loadConfig: async () => next,
    });
    expectFolded(plain(r));
    await r.type("/config");
    await press(r, KEYS.enter);
    expect(plain(r)).toContain("$ ada first");
    expect(plain(r)).not.toContain("Used 2 tools");
    next = loaded(testConfig());
    await r.type("/config");
    await press(r, KEYS.enter);
    expectFolded(plain(r));
  });
});
