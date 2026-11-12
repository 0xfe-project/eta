/**
 * The whole interface drawn in memory with `createTerminalMouse`, as `main` draws it: stdin passes
 * through the mouse filter, the wheel and the reporting are provided around the App, and
 * `runInterface` hands it the terminal. The wheel scrolls the conversation as the line keys do, leaves nothing in the input,
 * stops under a layer, and the reporting follows the setting through `/config`.
 */
import type {
  AgentView,
  ConversationInfo,
  MessageView,
} from "@eta/client-contracts";
import type { LoadedConfig, TuiConfig } from "../../src/config/types";
import type {
  RenderedItem,
  TranscriptItem,
} from "../../src/ext/conversation/contract";
import type { TranscriptUi } from "../../src/ext/conversation/transcript/ui";
import type { Extension } from "../../src/extensions/types";
import type { ProcessLaunch } from "../../src/ui/editor";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render as inkRender, Text } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { Transcript } from "../../src/ext/conversation/transcript/transcript";
import { INITIAL_TRANSCRIPT_UI } from "../../src/ext/conversation/transcript/ui";
import { PickList } from "../../src/ext/kit/pick-list";
import { extensions as realExtensions } from "../../src/extensions.gen";
import { ConfigContext, WheelContext } from "../../src/extensions/react";
import { createRegistry } from "../../src/extensions/registry";
import { LocaleContext } from "../../src/i18n/react";
import { App } from "../../src/ui/app";
import { LayerFrame } from "../../src/ui/components/layer-frame";
import {
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
} from "../../src/ui/mouse/reporting";
import { createTerminalMouse } from "../../src/ui/mouse/terminal";
import { createWheelEvents } from "../../src/ui/mouse/wheel";
import { runInterface } from "../../src/ui/run-interface";
import { TEST_PATHS, TEST_URL } from "../ui-support/app";
import { loaded, testConfig } from "../ui-support/config";
import { FakeController } from "../ui-support/fake-controller";
import { fakeWire } from "../ui-support/fake-wire";
import { flush, KEYS, plain, realDelay, renderInk } from "../ui-support/render";

vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const ESC = "\u001B";
const sgr = (button: number, final: "M" | "m" = "M") =>
  `${ESC}[<${button};12;6${final}`;
const x10 = (button: number) =>
  `${ESC}[M${String.fromCharCode(button + 32, 44, 38)}`;
const WHEEL_UP = sgr(64);
const WHEEL_DOWN = sgr(65);
const LINE_UP = `${ESC}[1;2A`;
const LINE_DOWN = `${ESC}[1;2B`;
const SELECT = `${ESC}v`;
// Ink waits 20 ms for the rest of a sequence after a bare ESC, and the filter waits as long first.
const ESCAPE_SETTLES_MS = 120;
// The transcript's hint that it is not at the newest line, with the test settings' key back.
const AWAY_HINT = "↓ ctrl+end to go to the bottom";

const ID = "c1";

function row(seq: number): MessageView {
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
  };
}

const target = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 1,
});

/** A conversation of `count` one-line messages, with or without older ones to page back to. */
function conversationWire(count: number, hasMore = false) {
  const rows = Array.from({ length: count }, (_, i) => row(i + 1));
  const info = {
    id: ID,
    projectId: "p1",
    kind: "direct",
    name: "Notes",
    readSeq: count,
    lastSeq: count,
  } as ConversationInfo;
  return fakeWire({
    ops: ["conversations.send", "conversations.stop", "conversations.history"],
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
        timeline: { messages: rows, hasMore, held: [] },
      }),
    },
  });
}

class MemoryStdout extends EventEmitter {
  readonly frames: string[] = [];
  isTTY = false;
  readonly columns: number;
  readonly rows: number;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

/** The terminal's side of stdin: each write is one read. */
class TerminalStdin extends EventEmitter {
  isTTY = true;
  private readonly pending: string[] = [];
  write(data: string): void {
    this.pending.push(data);
    this.emit("readable");
  }

  read = (): string | null => this.pending.shift() ?? null;
  setEncoding(): void {}
  setRawMode(): void {}
  ref(): void {}
  unref(): void {}
}

class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  exit = (code: number): void => {
    this.exits.push(code);
  };

  stderr = { write: (): boolean => true };
}

interface MountOptions {
  config?: TuiConfig;
  loadConfig?: (file: string) => Promise<LoadedConfig>;
  messages?: number;
  hasMore?: boolean;
  /** The terminal's height; 16 when absent. */
  rows?: number;
  /** Added to the real extensions. */
  extensions?: Extension[];
}

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const one of mounted.splice(0)) one.unmount();
});

async function mount(options: MountOptions = {}) {
  const config = options.config ?? testConfig();
  const wire = conversationWire(options.messages ?? 40, options.hasMore);
  const controller = new FakeController(
    { name: "connected", url: TEST_URL, temporary: false },
    { wire },
  );
  const stdout = new MemoryStdout(60, options.rows ?? 16);
  const stderr = new MemoryStdout(60, 16);
  const terminal = new TerminalStdin();
  // What the terminal's mouse reporting was told, as "on" and "off".
  const mouse: string[] = [];
  // The reporting and the frames, in the order they were written.
  const order: string[] = [];
  const write = stdout.write;
  stdout.write = (frame: string) => {
    order.push("frame");
    return write(frame);
  };
  const terminalMouse = createTerminalMouse({
    stdin: terminal,
    write: (text) => {
      const name =
        text === MOUSE_REPORTING_ON
          ? "on"
          : text === MOUSE_REPORTING_OFF
            ? "off"
            : `other:${JSON.stringify(text)}`;
      mouse.push(name);
      order.push(name);
    },
  });
  const launches: { launch: ProcessLaunch; mouse: string[] }[] = [];
  const proc = new FakeProcess();
  let instance: ReturnType<typeof inkRender> | undefined;

  runInterface({
    process: proc,
    controller: { stop: async () => {}, killTemporaryNow: () => {} },
    deadlineMs: 1_000,
    mouse: terminalMouse.reporting,
    startProgram: (launch) => {
      launches.push({ launch, mouse: [...mouse] });
      return { exited: Promise.resolve(0), kill: () => {} };
    },
    draw: ({ quit, runProcess }) => {
      instance = inkRender(
        terminalMouse.provide(
          <App
            deps={{
              controller,
              registry: createRegistry([
                ...realExtensions,
                ...(options.extensions ?? []),
              ]),
              paths: TEST_PATHS,
              initialConfig: loaded(config),
              initialState: {
                tabs: [{ kind: CONVERSATION_VIEW, id: ID }],
                activeTab: 0,
              },
              env: { EDITOR: "fake-ed" },
              platform: "linux",
              tuiVersion: "dev",
              loadConfig: options.loadConfig ?? (async () => loaded(config)),
              ensureConfigFile: async () => undefined,
              saveState: async () => undefined,
              runProcess,
              which: () => null,
              quit,
            }}
          />,
        ),
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stderr as unknown as NodeJS.WriteStream,
          stdin: terminalMouse.stdin,
          debug: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      return instance;
    },
  });
  const unmount = () => {
    instance?.unmount();
    instance?.cleanup();
  };
  mounted.push({ unmount });
  await flush();
  await realDelay(30);
  await flush();

  const send = async (data: string) => {
    terminal.write(data);
    if (data === KEYS.escape) await realDelay(ESCAPE_SETTLES_MS);
    await flush();
  };
  return {
    wire,
    mouse,
    order,
    launches,
    send,
    type: async (text: string) => {
      for (const char of text) await send(char);
    },
    /** Several reads in a row, with nothing let run between them. */
    sendReads: async (reads: string[]) => {
      for (const data of reads) terminal.write(data);
      await flush();
    },
    /**
     * Several reads, each let pass its steps on before the next arrives, with no render between:
     * only microtasks run between them, and React renders these updates in a task of its own.
     * Returns how many frames were written before the last microtask, which must be none.
     */
    sendReadsBeforeRender: async (reads: string[]) => {
      const before = stdout.frames.length;
      for (const data of reads) {
        terminal.write(data);
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      const framesBetween = stdout.frames.length - before;
      await flush();
      return framesBetween;
    },
    screen: () => stripVTControlCharacters(stdout.frames.at(-1) ?? ""),
    /** Frames written so far; in debug mode Ink writes one per React commit. */
    frameCount: () => stdout.frames.length,
  };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

const linesShown = (r: Mounted) =>
  [...r.screen().matchAll(/line (\d+)/g)].map((m) => Number(m[1]));

describe("the wheel over the conversation", () => {
  it("scrolls three lines toward older ones per turn up, as three line-up presses do", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    const before = wheeled.screen();
    const shownBefore = linesShown(wheeled);

    await wheeled.send(WHEEL_UP);
    for (let i = 0; i < 3; i += 1) await keyed.send(LINE_UP);

    expect(wheeled.screen()).not.toBe(before);
    expect(Math.min(...linesShown(wheeled))).toBeLessThan(
      Math.min(...shownBefore),
    );
    expect(wheeled.screen()).toContain(AWAY_HINT);
    expect(wheeled.screen()).toBe(keyed.screen());
  });

  it("scrolls three lines toward newer ones per turn down, as three line-down presses do", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    const atBottom = wheeled.screen();
    for (let i = 0; i < 3; i += 1) {
      await wheeled.send(WHEEL_UP);
      for (let j = 0; j < 3; j += 1) await keyed.send(LINE_UP);
    }

    await wheeled.send(WHEEL_DOWN);
    for (let i = 0; i < 3; i += 1) await keyed.send(LINE_DOWN);
    expect(wheeled.screen()).toContain(AWAY_HINT);
    expect(wheeled.screen()).toBe(keyed.screen());

    await wheeled.send(WHEEL_DOWN);
    await wheeled.send(WHEEL_DOWN);
    for (let i = 0; i < 6; i += 1) await keyed.send(LINE_DOWN);
    expect(wheeled.screen()).toBe(keyed.screen());
    await wheeled.send(WHEEL_DOWN);
    expect(wheeled.screen()).toBe(atBottom);
  });

  it("scrolls for every step when one read carries several", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    await wheeled.send(`${WHEEL_UP}${WHEEL_UP}${WHEEL_UP}`);
    for (let i = 0; i < 9; i += 1) await keyed.send(LINE_UP);
    expect(wheeled.screen()).toContain(AWAY_HINT);
    expect(wheeled.screen()).toBe(keyed.screen());
  });

  // Ink draws at most one frame per 34 ms; a commit that changes nothing on screen would take
  // that slot and push the frame that scrolls to the end of the period.
  it("draws a turn in one commit, as a line-up press does", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    const wheeledBefore = wheeled.frameCount();
    const keyedBefore = keyed.frameCount();
    await wheeled.send(WHEEL_UP);
    await keyed.send(LINE_UP);
    expect(keyed.frameCount() - keyedBefore).toBe(1);
    expect(wheeled.frameCount() - wheeledBefore).toBe(1);
  });

  it("draws the steps of one read in one commit", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    const before = wheeled.frameCount();
    await wheeled.send(`${WHEEL_UP}${WHEEL_UP}${WHEEL_UP}`);
    for (let i = 0; i < 9; i += 1) await keyed.send(LINE_UP);
    expect(wheeled.frameCount() - before).toBe(1);
    expect(wheeled.screen()).toBe(keyed.screen());
  });

  it("scrolls for every step when reads come one right after another", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    await wheeled.sendReads([
      WHEEL_UP,
      WHEEL_UP,
      WHEEL_UP,
      WHEEL_UP,
      WHEEL_DOWN,
    ]);
    for (let i = 0; i < 9; i += 1) await keyed.send(LINE_UP);
    expect(wheeled.screen()).toBe(keyed.screen());
  });

  it("scrolls on a turn with Shift, Meta or Ctrl held, and on an X10 turn", async () => {
    const wheeled = await mount();
    const keyed = await mount();
    await wheeled.send(sgr(64 + 4));
    await wheeled.send(sgr(64 + 8));
    await wheeled.send(sgr(64 + 16));
    await wheeled.send(x10(64));
    for (let i = 0; i < 12; i += 1) await keyed.send(LINE_UP);
    expect(wheeled.screen()).toBe(keyed.screen());
  });

  it("asks for older lines when a turn up reaches the top, as line-up does", async () => {
    const r = await mount({ messages: 20, hasMore: true });
    for (let i = 0; i < 10; i += 1) await r.send(WHEEL_UP);
    await realDelay(100);
    expect(r.wire.calls).toContain("conversations.history");
  });

  it("does not scroll while the transcript is selecting lines, as the line keys do not", async () => {
    const r = await mount();
    await r.send(SELECT);
    const selecting = r.screen();
    expect(selecting).toContain("v mark range");
    await r.send(WHEEL_UP);
    await r.send(WHEEL_UP);
    expect(r.screen()).toBe(selecting);
  });

  it("does not scroll for clicks, drags, releases and sideways turns", async () => {
    const r = await mount();
    const before = r.screen();
    await r.send(sgr(0));
    await r.send(sgr(0, "m"));
    await r.send(sgr(32));
    await r.send(sgr(66));
    await r.send(sgr(67));
    await r.send(x10(0));
    expect(r.screen()).toBe(before);
  });
});

describe("the input under the wheel", () => {
  it("gets none of a mouse sequence, whole, split or among keys", async () => {
    const mixed = await mount();
    const plainTyping = await mount();
    await mixed.send(`h${sgr(0)}${sgr(0, "m")}`);
    await mixed.send(`${ESC}[<3`);
    await mixed.send("5;12;6M");
    await mixed.send(`${x10(3)}i`);
    await plainTyping.type("hi");
    expect(mixed.screen()).toBe(plainTyping.screen());
    expect(mixed.screen()).toContain("hi");
  });

  it("keeps what was typed while the wheel scrolls", async () => {
    const r = await mount();
    await r.type("ab");
    await r.send(`${WHEEL_UP}c${WHEEL_UP}`);
    const screen = r.screen();
    expect(screen).toContain("abc");
    expect(screen).not.toMatch(/\[<|<\d+;|\d+;\d+M/);
  });
});

describe("the wheel under a layer", () => {
  it("leaves the conversation where it was while a layer is open", async () => {
    const wheeled = await mount();
    const still = await mount();
    for (const r of [wheeled, still]) {
      await r.type("/help");
      await r.send(KEYS.enter);
    }
    expect(wheeled.screen()).toContain("/config");
    await wheeled.send(WHEEL_UP);
    await wheeled.send(WHEEL_UP);
    for (const r of [wheeled, still]) await r.send(KEYS.escape);
    expect(wheeled.screen()).toBe(still.screen());
    expect(wheeled.screen()).not.toContain(AWAY_HINT);
  });
});

describe("the mouse reporting", () => {
  it("is turned on once the interface is drawn, with the setting on", async () => {
    const r = await mount();
    expect(r.mouse).toEqual(["on"]);
    expect(r.order.indexOf("frame")).toBeGreaterThan(-1);
    expect(r.order.indexOf("on")).toBeGreaterThan(r.order.indexOf("frame"));
  });

  it("is never written to with the setting off", async () => {
    const r = await mount({ config: testConfig({ mouse: false }) });
    await r.send(LINE_UP);
    expect(r.mouse).toEqual([]);
  });

  it("is off while /config has the editor open, and follows the setting it applies", async () => {
    const r = await mount({
      loadConfig: async () => loaded(testConfig({ mouse: false })),
    });
    await r.type("/config");
    await r.send(KEYS.enter);
    await realDelay(50);
    await flush();
    expect(r.launches.map((one) => one.launch.command)).toEqual(["fake-ed"]);
    expect(r.launches[0]?.mouse).toEqual(["on", "off"]);
    expect(r.mouse).toEqual(["on", "off", "on", "off"]);
  });

  it("is turned on when /config applies the setting on", async () => {
    const r = await mount({
      config: testConfig({ mouse: false }),
      loadConfig: async () => loaded(testConfig({ mouse: true })),
    });
    await r.type("/config");
    await r.send(KEYS.enter);
    await realDelay(50);
    await flush();
    expect(r.launches).toHaveLength(1);
    expect(r.mouse).toEqual(["on"]);
  });
});

const PICKED: string[] = [];
const ITEMS = Array.from({ length: 30 }, (_, i) => ({
  key: `item${i}`,
  label: `Choice ${i}`,
}));

/**
 * `/picker` opens a layer whose list sizes itself to the frame, as the kit's lists do, under
 * `notes` lines of text.
 */
const pickerExtension = (notes: number): Extension => ({
  id: "zz-picker",
  commands: [
    {
      name: "picker",
      args: [],
      summary: { en: "Open a picker", zh: "打开选择器" },
      examples: [],
      requiredOps: [],
      run: (ctx) => {
        ctx.openLayer((handle) => (
          <LayerFrame title="Pick one" footer="Enter to pick">
            {Array.from({ length: notes }, (_, n) => (
              <Text key={n}>Note {n}</Text>
            ))}
            <PickList
              items={ITEMS}
              empty="none"
              onPick={(key) => {
                PICKED.push(key);
                handle.close();
              }}
            />
          </LayerFrame>
        ));
      },
    },
  ],
});

const moreBelow = (screen: string) =>
  Number(/↓ (\d+) more/.exec(screen)?.[1] ?? Number.NaN);
const moreAbove = (screen: string) =>
  Number(/↑ (\d+) more/.exec(screen)?.[1] ?? 0);

describe("the wheel over a layer", () => {
  it("scrolls a layer whose content does not fit three rows per step", async () => {
    const r = await mount({ rows: 14 });
    await r.type("/help");
    await r.send(KEYS.enter);
    const before = r.screen();
    const hiddenBelow = moreBelow(before);
    expect(hiddenBelow).toBeGreaterThan(6);
    expect(moreAbove(before)).toBe(0);

    await r.send(WHEEL_DOWN);
    expect(moreAbove(r.screen())).toBe(3);
    expect(moreBelow(r.screen())).toBe(hiddenBelow - 3);

    await r.send(`${WHEEL_DOWN}${WHEEL_DOWN}`);
    expect(moreAbove(r.screen())).toBe(9);

    await r.send(WHEEL_UP);
    expect(moreAbove(r.screen())).toBe(6);
    expect(moreBelow(r.screen())).toBe(hiddenBelow - 6);
  });

  it("draws a step in one commit", async () => {
    const r = await mount({ rows: 14 });
    await r.type("/help");
    await r.send(KEYS.enter);
    const before = r.frameCount();
    await r.send(WHEEL_DOWN);
    expect(moreAbove(r.screen())).toBe(3);
    expect(r.frameCount() - before).toBe(1);
  });

  it("scrolls for every step when reads come one right after another", async () => {
    const r = await mount({ rows: 14 });
    await r.type("/help");
    await r.send(KEYS.enter);
    await r.sendReads([WHEEL_DOWN, WHEEL_DOWN, WHEEL_DOWN, WHEEL_UP]);
    expect(moreAbove(r.screen())).toBe(6);
  });

  it("moves each read on from where the read before left it, when no render came between", async () => {
    const r = await mount({ rows: 14 });
    await r.type("/help");
    await r.send(KEYS.enter);
    // That each read reaches the frame's scrolling on its own, and not merged with the next, is
    // checked in use-wheel.test.tsx ("passes each read's steps on before the next read").
    const framesBetween = await r.sendReadsBeforeRender([
      WHEEL_DOWN,
      WHEEL_DOWN,
    ]);
    expect(framesBetween).toBe(0);
    expect(moreAbove(r.screen())).toBe(6);
  });
});

describe("the wheel over a layer with a list and more", () => {
  it("does not scroll the frame even when the rest of the layer does not fit", async () => {
    PICKED.length = 0;
    const r = await mount({
      rows: 14,
      config: testConfig({ locale: "zh" }),
      extensions: [pickerExtension(20)],
    });
    await r.type("/picker");
    await r.send(KEYS.enter);
    const before = r.screen();
    // The frame opens scrolled down to the list's cursor, the notes above it out of view.
    expect(before).toContain("› Choice 0");
    expect(before).toMatch(/↑ 还有 \d+ 行/);
    await r.send(WHEEL_DOWN);
    await r.send(WHEEL_DOWN);
    expect(r.screen()).toBe(before);
  });
});

/**
 * The transcript alone, its `ui` kept in the parent's state. The parent's state update renders in
 * a task of its own, so two reads can each pass their steps on before the transcript draws again.
 */
function mountTranscript() {
  const wheel = createWheelEvents();
  const items: TranscriptItem[] = [];
  const rendered: RenderedItem[] = [];
  // 10 items of 2 lines, a blank line between neighbours: 29 lines.
  for (let i = 0; i < 10; i += 1) {
    const key = `item${i}`;
    items.push({ kind: "text", key, text: key, streaming: false });
    const lines = [`${key}.0`, `${key}.1`];
    rendered.push({ lines, plain: lines, source: key, foldable: false });
  }
  const updates: Partial<TranscriptUi>[] = [];
  function Harness() {
    const [ui, setUi] = useState<TranscriptUi>(INITIAL_TRANSCRIPT_UI);
    return (
      <ConfigContext value={testConfig()}>
        <Transcript
          items={items}
          rendered={rendered}
          height={10}
          width={40}
          isActive
          ui={ui}
          onUi={(update) => {
            updates.push(update);
            setUi((was) => ({ ...was, ...update }));
          }}
          hasOlder={false}
          loadingOlder={false}
          onReachTop={() => {}}
          onNotify={() => {}}
        />
      </ConfigContext>
    );
  }
  const view = renderInk(
    <LocaleContext value="en">
      <WheelContext value={wheel}>
        <Harness />
      </WheelContext>
    </LocaleContext>,
    { columns: 40, rows: 12 },
  );
  mounted.push(view);
  return { wheel, view, updates };
}

describe("the wheel over the transcript", () => {
  it("moves each read on from where the read before left it, when no render came between", async () => {
    const { wheel, view, updates } = mountTranscript();
    await flush();
    const before = view.stdout.frames.length;
    // Each read must reach the transcript on its own: merged into one call, the stale position
    // this test is about could not show.
    const updatesAfterRead: number[] = [];
    for (const _read of [1, 2]) {
      wheel.emit("up");
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      updatesAfterRead.push(updates.length);
    }
    expect(updatesAfterRead).toEqual([1, 2]);
    expect(view.stdout.frames.length - before).toBe(0);
    await flush();
    // Following shows lines 19 to 28; two turns up, three lines each, start the view at line 13.
    expect(plain(view).split("\n")[0]).toBe("item4.1");
  });
});
