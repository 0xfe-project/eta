/**
 * Group replies framed in the whole interface against a wire whose state the test sets, drawn by
 * the real renderer: one colour per agent, a running reply framed to its bottom edge, the steps
 * unfolding inside the frame, wide characters and tables kept inside it, and no frame below 40
 * columns, also when the terminal is resized either way.
 */
import type {
  AgentView,
  ConversationInfo,
  MessageView,
} from "@eta/client-contracts";
import type { WireClient, WireState } from "../../src/connection/types";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { renderApp } from "../ui-support/app";
import { flush, KEYS, realDelay } from "../ui-support/render";

vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

const ID = "c1";
const KEY = {
  select: "\u001Bv",
  expandAll: "\u000F",
  toggleTurn: KEYS.alt("e"),
  pageUp: "\u001B[5~",
  lineDown: "\u001B[1;2B",
};
// The test theme's agent colours are magenta, blueBright, greenBright. "a1" hashes to the second,
// "a2" to the first (transcript-frames.test.ts pins the hash). "ada" (Ann) hashes to the second too,
// and comes after "a1" among the members, so it moves on to the third.
const ADA_COLOUR = "\u001B[94m";
const BEA_COLOUR = "\u001B[35m";
const ANN_COLOUR = "\u001B[92m";
const ACCENT = "\u001B[36m";
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[[\d;]*m/;

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

/** A finished reply from `agentId` that ran a command and then said `words`. */
function workedReply(seq: number, agentId: string, words: string): MessageView {
  return row(seq, {
    author: "agent",
    agentId,
    text: words,
    thinking: "",
    data: {
      activity: [
        {
          id: `call${seq}`,
          name: "bash",
          input: { command: `echo ${seq}` },
          output: `out ${seq}`,
          status: "completed",
        },
      ],
    },
  });
}

const said = (seq: number, agentId: string, words: string) =>
  row(seq, { author: "agent", agentId, text: words });

const target = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 1,
});

function sceneWire(rows: MessageView[], held: MessageView[] = []): WireClient {
  const last = rows.at(-1)?.seq ?? 0;
  const info = {
    id: ID,
    projectId: "p1",
    kind: "group",
    name: "Room",
    readSeq: last,
    lastSeq: last,
  } as ConversationInfo;
  const store = createStore<WireState>(() => ({
    status: "open",
    ops: ["conversations.send", "conversations.stop"],
    mounted: [],
    targets: {
      agents: target({
        list: [
          { id: "a1", name: "Ada" } as AgentView,
          { id: "a2", name: "Bea" } as AgentView,
          { id: "ada", name: "Ann" } as AgentView,
        ],
      }),
      conversations: target({
        list: [{ id: ID, name: "Room", participants: [] } as never],
      }),
      [`conversations.${ID}`]: target({
        info,
        members: [
          { agentId: "a1", sessionId: null, lastSeq: 0, status: "idle" },
          { agentId: "a2", sessionId: null, lastSeq: 0, status: "idle" },
          { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
        ],
        timeline: { messages: rows, hasMore: false, held },
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
  size: { columns?: number; rows?: number } = {},
  held: MessageView[] = [],
) {
  const r = await renderApp({
    patch: { wire: sceneWire(rows, held) },
    state: { tabs: [{ kind: CONVERSATION_VIEW, id: ID }], activeTab: 0 },
    columns: size.columns ?? 60,
    rows: size.rows ?? 30,
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

const lines = (r: { lastFrame: () => string }) => r.lastFrame().split("\n");
const plainLines = (r: { lastFrame: () => string }) =>
  lines(r).map((line) => stripVTControlCharacters(line).trimEnd());

/** The plain lines of the frame whose top edge names `name`, edges included. */
function frameOf(r: { lastFrame: () => string }, name: string): string[] {
  const all = plainLines(r);
  const top = all.findIndex((line) => line.startsWith(`╭─ ${name} `));
  expect(top, all.join("\n")).toBeGreaterThanOrEqual(0);
  const bottom = all.findIndex(
    (line, index) => index > top && line.startsWith("╰"),
  );
  expect(bottom, all.join("\n")).toBeGreaterThan(top);
  return all.slice(top, bottom + 1);
}

/** Every line of a frame `width` wide: corners or bars at both ends, nothing past them. */
function expectWellFramed(frame: string[], width: number) {
  for (const line of frame) {
    expect(stringWidth(line), line).toBe(width);
    expect(/^[╭│╰]/.test(line) && /[╮│╯]$/.test(line), line).toBe(true);
  }
  for (const line of frame.slice(1, -1))
    expect(
      line.startsWith("│ ") || line === `│${" ".repeat(width - 2)}│`,
      line,
    ).toBe(true);
}

const scene = () => [
  row(1, { text: "go" }),
  workedReply(2, "a1", "ada says done"),
  said(3, "a2", "bea agrees"),
];

describe("frames in a group conversation", () => {
  it("frames each reply under its agent's name, the user's message bare", async () => {
    const r = await show(scene());
    const screen = plainLines(r);
    expect(screen).toContain("› go");
    expect(screen.some((line) => line.startsWith("● "))).toBe(false);
    const ada = frameOf(r, "Ada");
    expectWellFramed(ada, 60);
    expect(ada.some((line) => line.includes("▸ Used 1 tool"))).toBe(true);
    expect(ada.some((line) => line.includes("ada says done"))).toBe(true);
    const bea = frameOf(r, "Bea");
    expectWellFramed(bea, 60);
    expect(bea.some((line) => line.includes("bea agrees"))).toBe(true);
  });

  it("paints each agent's frame and name in its own colour and nothing else in it", async () => {
    const r = await show(scene());
    const all = lines(r);
    const at = (text: string) =>
      all[plainLines(r).findIndex((line) => line.includes(text))]!;
    const adaTop = at("╭─ Ada ");
    const beaTop = at("╭─ Bea ");
    expect(adaTop).toContain(ADA_COLOUR);
    expect(adaTop).toContain("\u001B[1m");
    expect(beaTop).toContain(BEA_COLOUR);
    expect(beaTop).not.toContain(ADA_COLOUR);
    expect(adaTop).not.toContain(ACCENT);
    const words = at("ada says done");
    expect(words).toContain(ADA_COLOUR);
    // The words between the bars carry no colour of their own, so no code sits between them.
    const inner = words.slice(
      words.indexOf("│ ") + 2,
      words.lastIndexOf(ADA_COLOUR),
    );
    expect(stripVTControlCharacters(inner).trim()).toBe("ada says done");
    // eslint-disable-next-line no-control-regex
    expect(inner.replace(/^\u001B\[39m/, "")).not.toMatch(SGR);
  });

  it("gives two members whose ids pick the same colour different colours", async () => {
    const r = await show([
      row(1, { text: "go" }),
      said(2, "a1", "from ada"),
      said(3, "ada", "from ann"),
    ]);
    const all = lines(r);
    const at = (text: string) =>
      all[plainLines(r).findIndex((line) => line.includes(text))]!;
    expect(at("╭─ Ada ")).toContain(ADA_COLOUR);
    expect(at("╭─ Ann ")).toContain(ANN_COLOUR);
    expect(at("╭─ Ann ")).not.toContain(ADA_COLOUR);
  });

  it("frames a reply that is still running down to its bottom edge, the newest line on screen", async () => {
    const r = await show([
      row(1, { text: "go" }),
      row(2, { author: "agent", agentId: "a1", text: "", status: "working" }),
    ]);
    const ada = frameOf(r, "Ada");
    expectWellFramed(ada, 60);
    expect(ada.some((line) => line.includes("Replying"))).toBe(true);
  });

  it("keeps a table and wide characters inside the frame", async () => {
    const table = [
      "| 名字 | value |",
      "|---|---|",
      `| ${"宽".repeat(30)} | ${"x".repeat(40)} |`,
    ].join("\n");
    const r = await show([
      row(1, { text: "go" }),
      said(2, "a1", `中文中文中文 ${"字".repeat(40)}\n\n${table}`),
    ]);
    expectWellFramed(frameOf(r, "Ada"), 60);
  });
});

describe("unfolding inside a frame", () => {
  const unfoldedInside = (r: { lastFrame: () => string }) => {
    const ada = frameOf(r, "Ada");
    expectWellFramed(ada, 60);
    expect(ada.some((line) => line.includes("▾ Used 1 tool"))).toBe(true);
    expect(ada.some((line) => line.includes("$ echo 2"))).toBe(true);
    expect(ada.some((line) => line.includes("ada says done"))).toBe(true);
  };

  it("unfolds the steps inside the same frame on Ctrl+O, and folds them back", async () => {
    const r = await show(scene());
    await press(r, KEY.expandAll);
    unfoldedInside(r);
    await press(r, KEY.expandAll);
    expect(
      frameOf(r, "Ada").some((line) => line.includes("▸ Used 1 tool")),
    ).toBe(true);
  });

  it("the toggle key unfolds the reply's steps inside its frame", async () => {
    const r = await show(scene());
    await press(r, KEY.toggleTurn);
    unfoldedInside(r);
  });

  it("space on the steps line in the selection unfolds them inside the frame", async () => {
    const r = await show(scene());
    await press(r, KEY.select);
    for (let i = 0; i < 12; i += 1) {
      const cursor = lines(r).find((line) => line.includes("\u001B[7m"));
      if (
        cursor !== undefined &&
        stripVTControlCharacters(cursor).includes("Used 1 tool")
      )
        break;
      await press(r, KEYS.up);
    }
    await press(r, " ");
    unfoldedInside(r);
  });
});

describe("narrow terminals", () => {
  it("below 40 columns draws the author's line and no frame", async () => {
    const r = await show(scene(), { columns: 39 });
    const screen = plainLines(r);
    expect(screen).toContain("● Ada");
    expect(screen).toContain("● Bea");
    expect(screen.some((line) => /[╭╰│]/.test(line))).toBe(false);
  });

  it("at 40 columns frames the replies", async () => {
    const r = await show(scene(), { columns: 40 });
    expectWellFramed(frameOf(r, "Ada"), 40);
  });

  it("drops and brings back the frames as the terminal is resized, the scroll staying on the same item", async () => {
    const many = [
      row(1, { text: "go" }),
      ...Array.from({ length: 12 }, (_, i) =>
        said(i + 2, i % 2 === 0 ? "a1" : "a2", `words ${i + 2}`),
      ),
    ];
    const r = await show(many, { rows: 20 });
    expect(plainLines(r).some((line) => line.startsWith("╭"))).toBe(true);
    await press(r, KEY.pageUp);
    // Scroll on until the first row is a line of words, so the narrow view can be checked by them.
    for (let i = 0; i < 5 && !/words \d+/.test(plainLines(r)[0]!); i += 1)
      await press(r, KEY.lineDown);
    const topWide = plainLines(r)[0]!;
    const named = /words \d+/.exec(topWide)?.[0];
    expect(named, topWide).toBeDefined();
    r.stdout.resize(39, 20);
    await settle();
    expect(plainLines(r).some((line) => line.startsWith("╭"))).toBe(false);
    expect(plainLines(r)[0]).toContain(named);
    r.stdout.resize(60, 20);
    await settle();
    expect(plainLines(r)[0]).toBe(topWide);
  });
});

describe("the rows under the transcript on a short terminal", () => {
  const SHORT = 6;

  it("draws the waiting message and who is replying whole, the transcript giving up its rows", async () => {
    const r = await show(
      [
        row(1, { text: "go" }),
        ...Array.from({ length: 6 }, (_, i) =>
          said(i + 2, "a2", `words ${i + 2}\nmore\nand more`),
        ),
        row(9, { author: "agent", agentId: "a1", text: "", status: "working" }),
      ],
      // At 6 rows the input, the tab bar and these two rows take all but one row: without
      // flexShrink={0} Yoga squeezes them and the waiting message loses its row.
      { rows: SHORT },
      [row(10, { text: "waiting for its turn" })],
    );
    const screen = plainLines(r);
    expect(screen).toContain("⧗ waiting for its turn");
    expect(
      screen.some((line) => line.startsWith("Ada is replying")),
      screen.join("\n"),
    ).toBe(true);
    expect(screen).toHaveLength(SHORT);
  });
});
