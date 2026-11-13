/**
 * The conversation view's wiring against a wire whose answers the test scripts: paging back
 * through the history, a send that fails while the user types on, the clipboard the selection
 * writes to, folding seen on screen, the preview setting, the project's files, and the transcript
 * left alone while the input changes.
 */
import type {
  AgentView,
  ConversationInfo,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { TuiConfig } from "../../src/config/types";
import type { WireClient, WireState } from "../../src/connection/types";
import { Buffer } from "node:buffer";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { layoutTranscript } from "../../src/ext/conversation/transcript/layout";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { flush, KEYS, plain, realDelay } from "../ui-support/render";

vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

// Counts the layouts the transcript makes, and otherwise does what the module does.
vi.mock("../../src/ext/conversation/transcript/layout", async (original) => {
  const actual =
    await original<
      typeof import("../../src/ext/conversation/transcript/layout")
    >();
  return { ...actual, layoutTranscript: vi.fn(actual.layoutTranscript) };
});

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ID = "c1";
const KEY = {
  pageUp: "\u001B[5~",
  top: "\u001B[1;5H",
  select: "\u001Bv",
  expandAll: "\u000F",
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

const rowsFrom = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

const target = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 1,
});

interface Scene {
  rows: MessageView[];
  hasMore?: boolean;
  members?: MemberView[];
  /** Answers a call; the default answers nothing. */
  answer?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  ops?: string[];
}

function sceneWire(scene: Scene): WireClient & {
  calls: { op: string; args: Record<string, unknown> }[];
} {
  const last = scene.rows.at(-1)?.seq ?? 0;
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
    ops: scene.ops ?? [
      "conversations.send",
      "conversations.stop",
      "conversations.history",
      "projects.files",
    ],
    mounted: [],
    targets: {
      agents: target({ list: [{ id: "a1", name: "Ada" } as AgentView] }),
      conversations: target({
        list: [{ id: ID, name: "Notes", participants: [] } as never],
      }),
      [`conversations.${ID}`]: target({
        info,
        members: scene.members ?? [
          { agentId: "a1", sessionId: "s1", lastSeq: 0, status: "idle" },
        ],
        timeline: {
          messages: scene.rows,
          hasMore: scene.hasMore ?? false,
          held: [],
        },
      }),
    },
    missing: {},
    error: undefined,
  }));
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  return {
    store,
    calls,
    can: (op) => store.getState().ops.includes(op),
    call: <T,>(name: string, action: string, args?: unknown) => {
      const op = `${name}.${action}`;
      const given = (args ?? {}) as Record<string, unknown>;
      calls.push({ op, args: given });
      return (scene.answer?.(op, given) ??
        Promise.resolve(undefined)) as Promise<T>;
    },
    subscribe: () => () => {},
    onEvent: () => () => {},
  };
}

async function show(
  scene: Scene,
  options: {
    config?: TuiConfig;
    rows?: number;
    columns?: number;
    tabs?: number;
  } = {},
) {
  const wire = sceneWire(scene);
  const tabs = [
    { kind: CONVERSATION_VIEW, id: ID },
    ...(options.tabs === 2 ? [{ kind: "elsewhere", id: "x" }] : []),
  ];
  const r = await renderApp({
    patch: { wire },
    state: { tabs, activeTab: 0 },
    columns: options.columns ?? 60,
    rows: options.rows ?? 16,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  open.push(r);
  await flush();
  return { r, wire };
}

const asked = (
  wire: { calls: { op: string; args: Record<string, unknown> }[] },
  op: string,
) => wire.calls.filter((call) => call.op === op);

/** History pages of 50 rows back from `beforeSeq`, down to seq 1. */
const pages = async (op: string, args: Record<string, unknown>) => {
  if (op !== "conversations.history") return undefined;
  const before = args.beforeSeq as number;
  const from = Math.max(1, before - (args.limit as number));
  return {
    conversationId: ID,
    messages: rowsFrom(from, before - 1),
    hasMore: from > 1,
  };
};

describe("paging back", () => {
  it("asks for one page per reach of the top", async () => {
    const { r, wire } = await show({
      rows: rowsFrom(201, 240),
      hasMore: true,
      answer: pages,
    });
    await realDelay(50);
    expect(asked(wire, "conversations.history")).toEqual([]);
    await r.press(KEY.top);
    await realDelay(200);
    const before = () =>
      asked(wire, "conversations.history").map((call) => call.args.beforeSeq);
    expect(before()).toEqual([201]);
    expect(plain(r)).not.toContain("line 150");
    await r.press(KEY.top);
    await realDelay(200);
    expect(before()).toEqual([201, 151]);
  });

  it("asks nothing for a scroll up that comes after a page and before the page is drawn", async () => {
    let answer: (page: unknown) => void = () => {};
    const { r, wire } = await show({
      rows: rowsFrom(201, 240),
      hasMore: true,
      answer: (op, args) =>
        op === "conversations.history"
          ? new Promise((resolve) => {
              answer = resolve;
            }).then(() => pages(op, args))
          : Promise.resolve(undefined),
    });
    await r.press(KEY.top);
    const before = () =>
      asked(wire, "conversations.history").map((call) => call.args.beforeSeq);
    expect(before()).toEqual([201]);
    answer(undefined);
    // The page reaches the store in promise callbacks; it is drawn a turn of the event loop later.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await r.press(KEY.top);
    await realDelay(200);
    expect(before()).toEqual([201]);
  });

  it("asks nothing when the window says nothing is older, whatever its first seq", async () => {
    const { r, wire } = await show({
      rows: [row(2), row(3)],
      hasMore: false,
      answer: pages,
    });
    await r.press(KEY.pageUp);
    await r.press(KEY.top);
    await realDelay(200);
    expect(asked(wire, "conversations.history")).toEqual([]);
  });

  it("stops after an empty page", async () => {
    const { r, wire } = await show({
      rows: [row(2), row(3)],
      hasMore: true,
      answer: async () => ({
        conversationId: ID,
        messages: [],
        hasMore: false,
      }),
    });
    await r.press(KEY.pageUp);
    await realDelay(200);
    await r.press(KEY.pageUp);
    await r.press(KEY.top);
    await realDelay(200);
    expect(asked(wire, "conversations.history")).toHaveLength(1);
  });

  it.each([
    [
      "a host that fails",
      async () => {
        throw new Error("history is broken");
      },
    ],
    // A wire that is down rejects the call before it leaves.
    ["a wire that is down", () => Promise.reject(new Error("not connected"))],
  ])(
    "asks once per reach of the top from %s, and says it failed",
    async (_name, answer) => {
      const { r, wire } = await show({
        rows: [row(2), row(3)],
        hasMore: true,
        answer,
      });
      await r.press(KEY.pageUp);
      await realDelay(300);
      expect(asked(wire, "conversations.history")).toHaveLength(1);
      expect(plain(r)).toMatch(/Failed: .*(history is broken|not connected)/);
      await r.press(KEY.pageUp);
      await realDelay(300);
      expect(asked(wire, "conversations.history")).toHaveLength(2);
    },
  );
});

describe("a send that fails while the user types on", () => {
  it("leaves what was typed since and only says it failed", async () => {
    let fail: (error: Error) => void = () => {};
    const { r, wire } = await show({
      rows: [row(1)],
      answer: (op) =>
        op === "conversations.send"
          ? new Promise((_resolve, reject) => {
              fail = reject;
            })
          : Promise.resolve(undefined),
    });
    await r.type("first words");
    await r.press(KEYS.enter);
    expect(asked(wire, "conversations.send")).toHaveLength(1);
    await r.type("second");
    fail(new Error("the host said no"));
    await flush();
    const screen = plain(r);
    expect(screen).toContain("› second");
    expect(screen).not.toContain("first words");
    expect(screen).toMatch(/Failed: .*the host said no/);
  });

  it("puts the words back when the input is still empty", async () => {
    let fail: (error: Error) => void = () => {};
    const { r } = await show({
      rows: [row(1)],
      answer: (op) =>
        op === "conversations.send"
          ? new Promise((_resolve, reject) => {
              fail = reject;
            })
          : Promise.resolve(undefined),
    });
    await r.type("first words");
    await r.press(KEYS.enter);
    fail(new Error("the host said no"));
    await flush();
    expect(plain(r)).toContain("› first words");
  });
});

describe("copying from the selection", () => {
  it("writes the OSC 52 sequence for the copied line to the terminal", async () => {
    vi.stubEnv("TMUX", "");
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      written.push(String(data));
      return true;
    });
    const { r } = await show({ rows: [row(1, { text: "copy me" })] });
    await r.press(KEY.select);
    await r.press("y");
    const base64 = Buffer.from("› copy me", "utf8").toString("base64");
    expect(written).toContain(`\u001B]52;c;${base64}\u0007`);
    expect(plain(r)).toContain("Copied 1 line");
  });
});

const output = (count: number) =>
  Array.from({ length: count }, (_, i) => `out ${i + 1}`).join("\n");

/** A finished reply that thought, then ran a command that printed `count` lines. */
function workedReply(count: number): MessageView {
  return row(2, {
    author: "agent",
    agentId: "a1",
    text: "",
    thinking: "a hidden thought",
    data: {
      activity: [
        {
          id: "t1",
          name: "bash",
          input: { command: "seq" },
          output: output(count),
          status: "completed",
        },
      ],
    },
  });
}

describe("folding, on screen", () => {
  const scene = () => ({ rows: [row(1, { text: "go" }), workedReply(12)] });
  // The tool card's own folding, with the reply's steps drawn as items rather than one line.
  const config = testConfig({ transcript: { toolCalls: "expanded" } });

  it("unfolds everything with Ctrl+O and folds it back", async () => {
    // The test settings show 10 lines of a tool's output.
    const { r } = await show(scene(), { rows: 30, config });
    expect(plain(r)).toContain("… 2 more lines");
    expect(plain(r)).not.toContain("out 12");
    expect(plain(r)).not.toContain("a hidden thought");
    await r.press(KEY.expandAll);
    await realDelay(50);
    await flush();
    expect(plain(r)).toContain("out 12");
    expect(plain(r)).toContain("a hidden thought");
    expect(plain(r)).not.toContain("more lines");
    await r.press(KEY.expandAll);
    await realDelay(50);
    await flush();
    expect(plain(r)).not.toContain("out 12");
    expect(plain(r)).not.toContain("a hidden thought");
  });

  it("unfolds the item under the cursor with space, and folds it again after Ctrl+O", async () => {
    const { r } = await show(scene(), { rows: 30, config });
    await r.press(KEY.select);
    await r.press(" ");
    await realDelay(50);
    await flush();
    expect(plain(r)).toContain("out 12");
    // The thinking above it stays folded.
    expect(plain(r)).not.toContain("a hidden thought");
    await r.press(KEYS.escape);
    await r.press(KEY.expandAll);
    await realDelay(50);
    await flush();
    // Unfolded on its own and then by all: the two cancel, the thinking unfolds.
    expect(plain(r)).toContain("a hidden thought");
    expect(plain(r)).toContain("… 2 more lines");
  });
});

describe("the preview setting", () => {
  it.each([
    [2, ["out 1", "out 2"], "… 10 more lines"],
    [8, ["out 1", "out 8"], "… 4 more lines"],
  ] as const)(
    "shows %i lines of a tool's output",
    async (previewLines, shown, more) => {
      const { r } = await show(
        { rows: [row(1, { text: "go" }), workedReply(12)] },
        {
          rows: 30,
          config: testConfig({
            toolOutput: { previewLines },
            transcript: { toolCalls: "expanded" },
          }),
        },
      );
      const screen = plain(r);
      for (const line of shown) expect(screen).toContain(line);
      expect(screen).not.toContain(`out ${previewLines + 1}\n`);
      expect(screen).toContain(more);
    },
  );
});

describe("the project's files", () => {
  const files = async (op: string) =>
    op === "projects.files"
      ? { files: ["src/app.ts", "README.md"] }
      : undefined;

  it("offers them after an @ and asks the host once per conversation", async () => {
    const { r, wire } = await show(
      { rows: [row(1)], answer: files },
      { tabs: 2 },
    );
    await r.type("@app");
    await flush();
    expect(plain(r)).toContain("src/app.ts");
    expect(asked(wire, "projects.files")).toEqual([
      { op: "projects.files", args: { projectId: "p1" } },
    ]);
    await r.press(KEYS.escape);
    for (let i = 0; i < 4; i += 1) await r.press(KEYS.backspace);
    await r.press(KEYS.altRight);
    await r.press(KEYS.altLeft);
    await r.type("@READ");
    await flush();
    expect(plain(r)).toContain("README.md");
    expect(asked(wire, "projects.files")).toHaveLength(1);
  });

  it("asks again the next time the menu opens after a failure", async () => {
    let fails = true;
    const { r, wire } = await show({
      rows: [row(1)],
      answer: async (op) => {
        if (op !== "projects.files") return undefined;
        if (fails) throw new Error("not now");
        return { files: ["src/app.ts"] };
      },
    });
    await r.type("@app");
    await flush();
    expect(plain(r)).not.toContain("src/app.ts");
    fails = false;
    await r.press(KEYS.escape);
    for (let i = 0; i < 4; i += 1) await r.press(KEYS.backspace);
    await r.type("@app");
    await flush();
    expect(asked(wire, "projects.files")).toHaveLength(2);
    expect(plain(r)).toContain("src/app.ts");
  });

  it("asks nothing more after a failure while the menu stays open and messages come", async () => {
    let fails = true;
    const { r, wire } = await show({
      rows: [row(1)],
      answer: async (op) => {
        if (op !== "projects.files") return undefined;
        if (fails) throw new Error("not now");
        return { files: ["src/app.ts"] };
      },
    });
    await r.type("@app");
    await flush();
    expect(asked(wire, "projects.files")).toHaveLength(1);
    for (const seq of [2, 3, 4]) {
      arrive(wire, row(seq));
      await flush();
    }
    expect(plain(r)).toContain("line 4");
    expect(plain(r)).toContain("@app");
    expect(asked(wire, "projects.files")).toHaveLength(1);
    fails = false;
    await r.press(KEYS.escape);
    for (let i = 0; i < 4; i += 1) await r.press(KEYS.backspace);
    await r.type("@app");
    await flush();
    expect(asked(wire, "projects.files")).toHaveLength(2);
    expect(plain(r)).toContain("src/app.ts");
  });
});

/** A new row in the conversation, as the host's next sections would bring it: `info` moves on too. */
function arrive(wire: WireClient, message: MessageView): void {
  const key = `conversations.${ID}`;
  wire.store.setState((state) => {
    const sections = state.targets[key]!.sections as {
      info: ConversationInfo;
      timeline: { messages: MessageView[] };
    };
    return {
      targets: {
        ...state.targets,
        [key]: target({
          ...sections,
          info: {
            ...sections.info,
            lastSeq: message.seq,
            readSeq: message.seq,
          },
          timeline: {
            ...sections.timeline,
            messages: [...sections.timeline.messages, message],
          },
        }),
      },
    };
  });
}

describe("the transcript while the input changes", () => {
  it("lays the transcript out again for none of the keys typed into the input", async () => {
    const { r } = await show({ rows: rowsFrom(1, 30) });
    const layouts = vi.mocked(layoutTranscript);
    await realDelay(50);
    await flush();
    const before = layouts.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await r.type("hello there");
    await r.press(KEYS.backspace);
    await flush();
    expect(plain(r)).toContain("› hello ther");
    expect(layouts.mock.calls.length).toBe(before);
  });
});
