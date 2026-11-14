/**
 * The conversation following its newest line on a real host while things unfold: the reply's
 * steps and thinking open and close with `transcript.expandAll` and `transcript.toggleTurn` while
 * the reply streams and after it ends, and the view keeps its last line at the bottom. A view
 * scrolled away that comes back to the last line because the lines or rows changed follows again;
 * one still scrolled away stays where it is.
 */
import type {
  AgentView,
  ConversationSummary,
  ProjectView,
} from "@eta/client-contracts";
import type { KernelModels } from "@eta/core";
import type { TuiConfig } from "../../src/config/types";
import type { RenderedApp } from "../ui-support/app";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { call, say } from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { Wire } from "../../src/connection/wire";
import { feedFor } from "../../src/ext/conversation/feed/store";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { baseUrl, testHost } from "../support/host";
import { tempDir, until } from "../support/temp";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { KEYS, plain } from "../ui-support/render";
import { screenShows, withAda, WITHOUT_SETUP } from "./view-host-world";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const KEY = {
  expandAll: "\u000F",
  toggleTurn: KEYS.alt("e"),
  lineUp: "\u001B[1;2A",
  pageUp: "\u001B[5~",
  bottom: "\u001B[1;5F",
  newline: KEYS.alt(KEYS.enter),
} as const;

/** The hint a view scrolled away from the newest line shows on its last row, with the test keys. */
const AWAY_HINT = "to go to the bottom";

type Message = ReturnType<typeof assistantMessage>;

/** A reply the test streams by hand: text arrives when the test says, and ends when it says. */
interface LiveReply {
  write: (text: string) => void;
  end: () => void;
}

/**
 * A turn of the scripted model: a settled message, streamed at once, or `live`, a text reply
 * the test writes into while it streams, under a thought of `thinking` when given.
 */
type Turn = Message | { live: true; thinking?: string };

/**
 * Models that answer request `index` with `script(index)`. `live()` is the live reply in flight,
 * once the host has asked for one.
 */
function liveModels(script: (index: number) => Turn) {
  let asked = 0;
  let current: LiveReply | undefined;
  const base = fakeModels([]);
  const models: KernelModels = {
    getModel: (provider, id) => base.getModel(provider, id),
    streamSimple: (model, context, options) => {
      const turn = script(asked);
      asked += 1;
      if (!("live" in turn))
        return fakeModels([turn]).streamSimple(model, context, options);
      // The event stream class comes from the model library the host uses, which this package
      // does not depend on; a scripted stream hands over its constructor.
      const sample = fakeModels([assistantMessage()]).streamSimple(
        model,
        context,
        options,
      );
      const stream = new (sample.constructor as new () => typeof sample)();
      // A stream is drawn only while it is newer than every message the run has kept.
      const timestamp = Date.now();
      const thought =
        turn.thinking === undefined
          ? []
          : [{ type: "thinking" as const, thinking: turn.thinking }];
      const textIndex = thought.length;
      let text = "";
      const message = () =>
        assistantMessage({
          timestamp,
          content: [...thought, { type: "text", text }],
        });
      stream.push({ type: "start", partial: message() });
      stream.push({
        type: "text_start",
        contentIndex: textIndex,
        partial: message(),
      });
      current = {
        write: (delta) => {
          text += delta;
          stream.push({
            type: "text_delta",
            contentIndex: textIndex,
            delta,
            partial: message(),
          });
        },
        end: () => {
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: text,
            partial: message(),
          });
          const done = message();
          stream.push({ type: "done", reason: "stop", message: done });
          stream.end(done);
          current = undefined;
        },
      };
      return stream;
    },
    completeSimple: async () => {
      throw new Error("these tests make no one-shot requests");
    },
  };
  return {
    models,
    /** Ends the live reply in flight, so the host can close. */
    endLive: () => current?.end(),
    live: async (): Promise<LiveReply> => {
      await until(() => current !== undefined, 20_000, "a live reply");
      return current!;
    },
  };
}

/** A failing tool call under a thought, as a reply's step. */
const step = (what: string): Message =>
  assistantMessage({
    timestamp: Date.now(),
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: `thinking about ${what}` },
      {
        type: "toolCall",
        id: `call-${what}`,
        name: "not_a_tool",
        arguments: { what },
      },
    ],
  });

const lines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");

/**
 * Ada, steward of her project, in a conversation drawn 80 columns wide with `config`, on a host
 * whose model answers by `script`.
 */
async function liveWorld(
  script: (index: number) => Turn,
  options: { config?: TuiConfig; rows?: number } = {},
) {
  const { models, live, endLive } = liveModels(script);
  const host = await testHost({ overrides: { models: models as never } });
  cleanups.push(endLive);
  const wire = new Wire({ url: wireUrl(baseUrl(host)) });
  cleanups.push(() => wire.close());
  wire.connect();
  await until(() => wire.store.getState().status === "open", 20_000, "hello");
  const ask = <T,>(target: string, action: string, args: unknown) =>
    wire.call<T>(target, action, args);
  const { agent: ada } = await ask<{ agent: AgentView }>("agents", "create", {
    name: "Ada",
    model: "fake:fake-model",
  });
  const { project } = await ask<{ project: ProjectView }>(
    "projects",
    "create",
    { path: await tempDir("eta-tui-project-"), stewardId: ada.id },
  );
  const { conversation } = await ask<{ conversation: ConversationSummary }>(
    "conversations",
    "create",
    { projectId: project.id, agentIds: [ada.id] },
  );
  const r = await renderApp({
    patch: { wire },
    state: {
      tabs: [{ kind: CONVERSATION_VIEW, id: conversation.id }],
      activeTab: 0,
    },
    without: WITHOUT_SETUP,
    config: options.config ?? testConfig(),
    columns: 80,
    rows: options.rows ?? 24,
  });
  cleanups.push(() => r.unmount());
  await screenShows(r, "Write a message");
  return {
    r,
    live,
    send: (text: string) =>
      ask("conversations", "send", { conversationId: conversation.id, text }),
    scroll: () => feedFor(wire, conversation.id).store.getState().ui.scroll,
    expandAll: () =>
      feedFor(wire, conversation.id).store.getState().ui.expandAll,
  };
}

// The box a reply may be drawn in: its corners, edges and rules carry no text.
const BOX = /^[\s│╭╮╰╯─]*$/;
const EDGES = /^│ ?|│$/g;

/**
 * The transcript's rows of the screen with any box drawn round a reply taken off: everything over
 * the input's top rule, without the reply status row.
 */
function transcriptRows(r: RenderedApp): string[] {
  const rows = plain(r).split("\n");
  const rule = rows.findIndex((row) => row.startsWith("────"));
  return rows
    .slice(0, rule)
    .filter((row) => !row.includes("is replying"))
    .map((row) => row.trimEnd().replace(EDGES, "").trim());
}

/** The view follows the newest line: `last` is its lowest line of text, and nothing says "below". */
async function following(
  r: RenderedApp,
  scroll: () => unknown,
  last: string,
): Promise<void> {
  // A view that does not follow never shows `last`; the checks below then say what it shows.
  await screenShows(r, (screen) => screen.includes(last), 5_000).catch(
    () => undefined,
  );
  const shown = transcriptRows(r).filter((row) => !BOX.test(row));
  expect(shown.at(-1)).toBe(last);
  expect(plain(r)).not.toContain(AWAY_HINT);
  expect(scroll()).toEqual({ follow: true });
}

describe("following the newest line while steps unfold", () => {
  it("keeps following when everything unfolds while a reply only writes text", async () => {
    const world = await liveWorld(
      (index) => (index === 0 ? say(lines("line", 30)) : { live: true }),
      { rows: 16 },
    );
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    const reply = await world.live();
    reply.write("streamed A\nstreamed B\n");
    await following(world.r, world.scroll, "streamed B");
    await world.r.press(KEY.expandAll);
    await following(world.r, world.scroll, "streamed B");
    reply.write("streamed C\n");
    await following(world.r, world.scroll, "streamed C");
    reply.end();
    await screenShows(world.r, (screen) => !screen.includes("is replying"));
    await following(world.r, world.scroll, "streamed C");
  }, 60_000);

  it("keeps following when the steps unfold while the reply streams after its tool calls", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 2) return step(`w${index}`);
      return { live: true };
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    const reply = await world.live();
    reply.write("streamed A\nstreamed B\n");
    await screenShows(world.r, "▸ Working");
    await following(world.r, world.scroll, "streamed B");
    await world.r.press(KEY.expandAll);
    await screenShows(world.r, "▾ Working");
    await following(world.r, world.scroll, "streamed B");
    reply.write("streamed C\n");
    await following(world.r, world.scroll, "streamed C");
    reply.end();
    await screenShows(world.r, "▾ Used 2 tools");
    await following(world.r, world.scroll, "streamed C");
  }, 60_000);

  it("keeps following when the steps and the reply's thought unfold under a long stream", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 5) return step(`w${index}`);
      return { live: true, thinking: "deep a\ndeep b\ndeep c" };
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    const reply = await world.live();
    for (let i = 1; i <= 27; i += 1) reply.write(`more ${i}\n`);
    await following(world.r, world.scroll, "more 27");
    await world.r.press(KEY.expandAll);
    await until(() => world.expandAll(), 5_000, "everything to unfold");
    // The thought unfolds above the view, out of sight. The items with the next line are drawn
    // with everything unfolded, so once that line shows, the unfolded drawing is on screen.
    reply.write("more 28\n");
    await following(world.r, world.scroll, "more 28");
    reply.end();
    await screenShows(world.r, (screen) => !screen.includes("is replying"));
    await following(world.r, world.scroll, "more 28");
  }, 60_000);

  it("keeps following when one turn's steps unfold and fold while the reply streams", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 2) return step(`w${index}`);
      return { live: true };
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    const reply = await world.live();
    reply.write("streamed A\n");
    await screenShows(world.r, "▸ Working");
    await world.r.press(KEY.toggleTurn);
    await screenShows(world.r, "▾ Working");
    await following(world.r, world.scroll, "streamed A");
    reply.write("streamed B\n");
    await following(world.r, world.scroll, "streamed B");
    await world.r.press(KEY.toggleTurn);
    await screenShows(world.r, "▸ Working");
    await following(world.r, world.scroll, "streamed B");
    reply.end();
    await screenShows(world.r, (screen) => !screen.includes("is replying"));
    await following(world.r, world.scroll, "streamed B");
  }, 60_000);

  it("keeps following when the thoughts and tool output unfold with the calls drawn one by one", async () => {
    const world = await liveWorld(
      (index) => {
        if (index === 0) return say(lines("line", 30));
        if (index <= 2) return step(`w${index}`);
        return { live: true, thinking: "deep a\ndeep b\ndeep c" };
      },
      { config: testConfig({ transcript: { toolCalls: "expanded" } }) },
    );
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    const reply = await world.live();
    reply.write("streamed A\n");
    await screenShows(world.r, "∴ Thinking · 3 lines");
    await world.r.press(KEY.expandAll);
    await screenShows(world.r, "deep c");
    await following(world.r, world.scroll, "streamed A");
    reply.write("streamed B\n");
    await following(world.r, world.scroll, "streamed B");
    reply.end();
    await screenShows(world.r, (screen) => !screen.includes("is replying"));
    await following(world.r, world.scroll, "streamed B");
  }, 60_000);

  it("keeps following when everything unfolds after the reply ended", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 2) return step(`w${index}`);
      return say("all done");
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    await screenShows(world.r, "▸ Used 2 tools");
    await following(world.r, world.scroll, "all done");
    await world.r.press(KEY.expandAll);
    await screenShows(world.r, "▾ Used 2 tools");
    await following(world.r, world.scroll, "all done");
  }, 60_000);

  it("keeps following when the steps unfold between tool calls that take their time", async () => {
    // The script of the sandbox host the interface is tried on, with shorter waits: three tool
    // calls a step apart, then an answer under a thought.
    const world = await withAda(async (request) => {
      // Messages since the user's last one: a call and its result per step taken.
      const steps = [...request.transcript]
        .reverse()
        .findIndex((line) => line.startsWith("user"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (steps === 0) return call("not_a_tool", { command: "ls -la" });
      if (steps === 2)
        return call("not_a_tool", { command: "cat package.json" });
      if (steps === 4) return call("not_a_tool", { command: "false" });
      return say(
        "## Done\n\nLooked.\n\n- one\n- two\n- three\n- four\n",
        "look first",
      );
    });
    const r = await world.showConversation(world.group.id);
    const scroll = () =>
      feedFor(world.wire, world.group.id).store.getState().ui.scroll;
    await screenShows(r, "Write a message");
    await world.send(world.group.id, "first");
    await screenShows(r, "Used 3 tools", 30_000);
    await world.send(world.group.id, "second");
    await screenShows(r, (screen) => screen.includes("▸ Working ("), 30_000);
    await r.press(KEY.expandAll);
    await screenShows(r, "▾ Working");
    expect(plain(r)).not.toContain(AWAY_HINT);
    expect(scroll()).toEqual({ follow: true });
    await screenShows(r, (screen) => !screen.includes("is replying"), 30_000);
    await following(r, scroll, "- four");
  }, 60_000);
});

describe("coming back to the newest line without scrolling", () => {
  it("follows again when a shorter input brings the last line back, and keeps following as everything unfolds and a reply streams", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 2) return step(`w${index}`);
      if (index === 3) return say("first done");
      return { live: true };
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    await screenShows(world.r, "first done");
    // A three-line draft takes two rows from the transcript.
    await world.r.type("a");
    await world.r.press(KEY.newline);
    await world.r.type("b");
    await world.r.press(KEY.newline);
    await world.r.type("c");
    await screenShows(world.r, (screen) => /^ *c *$/m.test(screen));
    await world.r.press(KEY.lineUp);
    await screenShows(world.r, AWAY_HINT);
    // Clearing the draft gives the rows back, and the last line is on screen again.
    for (let i = 0; i < 5; i += 1) await world.r.press(KEYS.backspace);
    await screenShows(world.r, (screen) => !screen.includes(AWAY_HINT));
    await world.r.press(KEY.expandAll);
    await screenShows(world.r, "▾ Used 2 tools");
    await following(world.r, world.scroll, "first done");
    await world.send("again");
    const reply = await world.live();
    reply.write("streamed A\n");
    await following(world.r, world.scroll, "streamed A");
  }, 60_000);

  it("stays scrolled away when everything unfolds and the last line is still below", async () => {
    // With no key back to the bottom the hint counts the lines below, so the unfolded steps, drawn
    // under the view and out of sight, show as a larger count.
    const config = testConfig();
    const world = await liveWorld(
      (index) => {
        if (index === 0) return say(lines("line", 30));
        if (index <= 2) return step(`w${index}`);
        return say("all done");
      },
      {
        config: {
          ...config,
          keybindings: { ...config.keybindings, "transcript.bottom": [] },
        },
      },
    );
    const below = () => Number(/↓ (\d+) lines below/.exec(plain(world.r))?.[1]);
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    await screenShows(world.r, "all done");
    await world.r.press(KEY.pageUp);
    await screenShows(world.r, (screen) => /↓ \d+ lines below/.test(screen));
    const top = transcriptRows(world.r)[0];
    const folded = below();
    await world.r.press(KEY.expandAll);
    // A view pulled back to the bottom has no count; the checks below then say so.
    await screenShows(world.r, () => below() > folded || world.scroll().follow);
    expect(transcriptRows(world.r)[0]).toBe(top);
    expect(world.scroll().follow).toBe(false);
  }, 60_000);

  it("goes back to the bottom after everything unfolded while scrolled away, the unfolded steps on screen", async () => {
    const world = await liveWorld((index) => {
      if (index === 0) return say(lines("line", 30));
      if (index <= 2) return step(`w${index}`);
      return say("all done");
    });
    await world.send("hi");
    await screenShows(world.r, "line 30");
    await world.send("go");
    await screenShows(world.r, "all done");
    await world.r.press(KEY.pageUp);
    await screenShows(world.r, AWAY_HINT);
    await world.r.press(KEY.expandAll);
    await until(() => world.expandAll(), 5_000, "everything to unfold");
    await world.r.press(KEY.bottom);
    await screenShows(world.r, "▾ Used 2 tools");
    await following(world.r, world.scroll, "all done");
  }, 60_000);
});
