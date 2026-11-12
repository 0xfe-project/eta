/**
 * The conversation view on a real host, driven with real keys: opening a conversation, sending,
 * steering and stopping a reply, the order Esc closes things in, coming back to a tab, folded
 * pastes, the read mark.
 */
import { describe, expect, it, vi } from "vitest";
import { HANG, say } from "../../../eta/test/support/models";
import { until } from "../support/temp";
import { flush, KEYS, plain, realDelay } from "../ui-support/render";
import {
  askedFor,
  KEY,
  quietGroup,
  screenShows,
  withAda,
} from "./view-host-world";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const REPLYING = "Ada is replying · escape to stop · tab to steer";
const HINT = "Write a message";

/** The rows of the screen above the input and its hint, the transcript's and the status line's. */
function screenLines(r: { lastFrame: () => string }) {
  return plain(r).split("\n");
}

describe("opening a conversation", () => {
  it("/open with the start of a name opens it as a tab with its rows", async () => {
    const world = await withAda(() => say("hello from Ada"), "Release notes");
    const sent = await world.send(world.group.id, "first words");
    await until(
      async () =>
        (
          await world.rowWhere(
            world.group.id,
            (row) => row.id === sent.replies[0]!.id,
          )
        )?.status === "done",
      20_000,
      "the reply",
    );
    const r = await world.show({ tabs: [], activeTab: undefined });
    await r.type("/open rel");
    await r.press(KEYS.enter);
    await screenShows(r, "hello from Ada");
    expect(plain(r)).toContain("first words");
    expect(screenLines(r).at(-1)).toContain("1:Release notes");
  }, 60_000);
});

describe("sending", () => {
  it("sends what is typed on Enter, queued, and draws the reply", async () => {
    const world = await withAda((request) =>
      request.last.includes("ping") ? say("pong") : say("?"),
    );
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await r.type("ping");
    await r.press(KEYS.enter);
    await screenShows(r, "pong");
    const sends = askedFor(world.wire, "conversations.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({
      conversationId: world.group.id,
      text: "ping",
      mentions: [],
      mode: "queue",
      clientId: expect.any(String),
    });
    expect(plain(r)).toContain("ping");
  }, 60_000);

  it("names the members it mentions and gives every message its own client id", async () => {
    const world = await withAda(() => say("ok"));
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await r.type("@Ada one");
    await r.press(KEYS.enter);
    await until(
      () => askedFor(world.wire, "conversations.send").length === 1,
      10_000,
      "the first send",
    );
    await r.type("two");
    await r.press(KEYS.enter);
    await until(
      () => askedFor(world.wire, "conversations.send").length === 2,
      10_000,
      "the second send",
    );
    const [first, second] = askedFor(world.wire, "conversations.send");
    expect(first).toMatchObject({ text: "@Ada one", mentions: [world.ada.id] });
    expect(second).toMatchObject({ text: "two", mentions: [] });
    expect(first!.clientId).not.toBe(second!.clientId);
  }, 60_000);

  it("warns when nobody took the message", async () => {
    const world = await quietGroup();
    const r = await world.showConversation(world.group.id, {
      columns: 120,
      rows: 24,
    });
    await screenShows(r, HINT);
    await r.type("anyone?");
    await r.press(KEYS.enter);
    await screenShows(
      r,
      "Nobody took this message: this conversation has no steward, so name a member with @",
    );
    const bar = r.lastFrame().split("\n").at(-2)!;
    expect(bar).toContain("\u001B[33m"); // warning, yellow in the test theme
  }, 60_000);

  it("puts the words back in an empty input when the send fails, and says so", async () => {
    const world = await withAda(() => say("ok"));
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await world.closeHost();
    await until(
      () => world.raw.store.getState().status !== "open",
      10_000,
      "the drop",
    );
    await r.type("lost words");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => s.includes("› lost words"));
    expect(askedFor(world.wire, "conversations.send")).toHaveLength(1);
    expect(screenLines(r).at(-2)).toMatch(/^Failed: /);
  }, 60_000);

  it("sends a folded paste with its place, and draws it folded", async () => {
    const world = await withAda(() => say("got it"));
    const r = await world.showConversation(world.group.id, {
      columns: 80,
      rows: 30,
    });
    await screenShows(r, HINT);
    const pasted = Array.from(
      { length: 8 },
      (_, i) => `paste line ${i + 1}`,
    ).join("\n");
    await r.type("see ");
    await r.press(KEYS.paste(pasted));
    await screenShows(r, "[Pasted text #1 +8 lines]");
    await r.press(KEYS.enter);
    await screenShows(r, "got it");
    const sends = askedFor(world.wire, "conversations.send");
    const text = `see ${pasted}`;
    expect(sends[0]).toMatchObject({ text, blocks: [[4, text.length]] });
    const stored = await world.rowWhere(
      world.group.id,
      (row) => row.author === "user",
    );
    expect(stored?.text).toBe(text);
    expect(stored?.data.blocks).toEqual([[4, text.length]]);
    expect(plain(r)).toContain("see [Pasted text +8 lines]");
    expect(plain(r)).not.toContain("paste line 5");
  }, 60_000);

  it("sends a folded paste after Chinese, an emoji and spaces at both ends, and draws it folded", async () => {
    const world = await withAda(() => say("got it"));
    const r = await world.showConversation(world.group.id, {
      columns: 80,
      rows: 30,
    });
    await screenShows(r, HINT);
    const pasted = Array.from({ length: 8 }, (_, i) => `粘贴 ${i + 1}`).join(
      "\n",
    );
    await r.type("  看 👍🏽 ");
    await r.press(KEYS.paste(pasted));
    await r.type("  ");
    await screenShows(r, "[Pasted text #1 +8 lines]");
    await r.press(KEYS.enter);
    await screenShows(r, "got it");
    // The spaces at either end go; "看 " is 2 code units, "👍🏽" 4 and the space 1: the paste starts at 7.
    const text = `看 👍🏽 ${pasted}`;
    const blocks = [[7, 7 + pasted.length]];
    expect(askedFor(world.wire, "conversations.send")[0]).toMatchObject({
      text,
      blocks,
    });
    const stored = await world.rowWhere(
      world.group.id,
      (row) => row.author === "user",
    );
    expect(stored?.text).toBe(text);
    expect(stored?.data.blocks).toEqual(blocks);
    expect(plain(r)).toContain("看 👍🏽 [Pasted text +8 lines]");
    expect(plain(r)).not.toContain("粘贴 5");
  }, 60_000);

  it("sends no blocks when nothing was folded", async () => {
    const world = await withAda(() => say("fine"));
    const r = await world.showConversation(world.group.id);
    await screenShows(r, HINT);
    await r.type("plain words");
    await r.press(KEYS.enter);
    await screenShows(r, "fine");
    expect(askedFor(world.wire, "conversations.send")[0]).not.toHaveProperty(
      "blocks",
    );
  }, 60_000);
});

/** Ada's first reply says nothing until it is stopped; any later one answers. */
const hangFirst = (request: { index: number }) =>
  request.index === 0 ? HANG : say("later answer");

async function hangingReply() {
  const world = await withAda(hangFirst);
  const sent = await world.send(world.group.id, "start working");
  const reply = sent.replies[0]!.id;
  await until(
    async () =>
      (await world.rowWhere(world.group.id, (row) => row.id === reply))
        ?.status === "working",
    20_000,
    "the reply to run",
  );
  const r = await world.showConversation(world.group.id);
  await screenShows(r, REPLYING);
  const replyStatus = async () =>
    (await world.rowWhere(world.group.id, (row) => row.id === reply))?.status;
  return { world, r, reply, replyStatus };
}

describe("a reply in flight", () => {
  it("shows the status line, steers with Tab, and stops with Esc", async () => {
    const { world, r, replyStatus } = await hangingReply();
    const status = screenLines(r).findIndex((line) =>
      line.startsWith(REPLYING),
    );
    const input = screenLines(r).findIndex((line) =>
      line.startsWith(`› ${HINT}`),
    );
    expect(input).toBe(status + 1);

    await r.type("turn left");
    await r.press(KEYS.tab);
    await screenShows(r, "Joined Ada's reply");
    const steer = askedFor(world.wire, "conversations.send");
    expect(steer).toEqual([
      expect.objectContaining({ text: "turn left", mode: "steer" }),
    ]);
    const steered = await world.rowWhere(
      world.group.id,
      (row) => row.text === "turn left",
    );
    expect(steered?.data.joined).toEqual([world.ada.id]);

    await r.press(KEYS.escape);
    await until(
      async () => (await replyStatus()) === "stopped",
      20_000,
      "stopped",
    );
    expect(askedFor(world.wire, "conversations.stop")).toEqual([
      { conversationId: world.group.id },
    ]);
    await screenShows(r, "■ Stopped");
    await screenShows(r, (s) => !s.includes("is replying"));
  }, 60_000);

  it("closes the search bar first on Esc, then the selection, then the menu, and only then stops the reply", async () => {
    const { world, r, replyStatus } = await hangingReply();
    const stops = () => askedFor(world.wire, "conversations.stop");

    // The empty search bar: the slash, then the input's cursor cell, which ends the line blank.
    const searchBar = (s: string) =>
      s.split("\n").some((line) => /^\/ *$/.test(line));
    await r.press(KEY.search);
    await screenShows(r, searchBar);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !searchBar(s));
    expect(stops()).toEqual([]);
    expect(plain(r)).toContain(REPLYING);

    await r.press(KEY.select);
    await screenShows(r, "Esc");
    const selecting = plain(r);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => s !== selecting);
    expect(stops()).toEqual([]);

    await r.type("/");
    await screenShows(r, "/open");
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes("/open"));
    expect(stops()).toEqual([]);
    expect(plain(r)).toContain("› /");
    expect(await replyStatus()).toBe("working");

    await r.press(KEYS.backspace);
    await r.press(KEYS.escape);
    await until(
      async () => (await replyStatus()) === "stopped",
      20_000,
      "stopped",
    );
    expect(stops()).toEqual([{ conversationId: world.group.id }]);
  }, 60_000);

  it("closes an open layer first on Esc and leaves the reply running", async () => {
    const { world, r, replyStatus } = await hangingReply();
    await r.type("/help");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes(REPLYING));
    const layer = plain(r);
    await r.press(KEYS.escape);
    await screenShows(r, REPLYING);
    expect(plain(r)).not.toBe(layer);
    await realDelay(200);
    expect(askedFor(world.wire, "conversations.stop")).toEqual([]);
    expect(await replyStatus()).toBe("working");
  }, 60_000);
});

describe("coming back to a tab", () => {
  it("keeps the draft and the scroll, and lets go of the conversation while away", async () => {
    const world = await quietGroup();
    for (let i = 1; i <= 30; i += 1)
      await world.send(world.group.id, `row ${i}`);
    const other = await world.conversation(world.project.id, [
      world.ada.id,
      world.ben.id,
    ]);
    await world.send(other.id, "other words");
    const r = await world.show({
      tabs: [
        { kind: "conversation", id: world.group.id },
        { kind: "conversation", id: other.id },
      ],
      activeTab: 0,
    });
    await screenShows(r, "row 30");
    await r.type("half written");
    await r.press(KEY.pageUp);
    await screenShows(r, "below");
    const before = plain(r);
    const firstLine = before.split("\n")[0];
    expect(before).not.toContain("row 30");

    await r.press(KEYS.altRight);
    await screenShows(r, "other words");
    // How many users hold each target on the wire: the view held one share, the tab's label holds
    // the other while the tab is open.
    const holders = (id: string) =>
      (world.raw as unknown as { users: Map<string, number> }).users.get(
        `conversations.${id}`,
      ) ?? 0;
    expect(holders(world.group.id)).toBe(1);
    expect(holders(other.id)).toBe(2);
    expect(plain(r)).not.toContain("half written");

    await r.press(KEYS.altLeft);
    await screenShows(r, "› half written");
    await screenShows(r, "below");
    expect(plain(r).split("\n")[0]).toBe(firstLine);
    expect(holders(world.group.id)).toBe(2);
  }, 60_000);
});

describe("the read mark", () => {
  it("moves to the newest row while the view follows the bottom, once per row, and not while scrolled up", async () => {
    const world = await quietGroup();
    for (let i = 1; i <= 30; i += 1)
      await world.send(world.group.id, `row ${i}`);
    expect(world.listed(world.group.id)?.readSeq).toBe(0);
    const r = await world.showConversation(world.group.id);
    await screenShows(r, "row 30");
    await until(
      () => world.listed(world.group.id)?.readSeq === 30,
      10_000,
      "the read mark at 30",
    );
    await r.type("abc");
    await flush();
    expect(askedFor(world.wire, "conversations.read")).toEqual([
      { conversationId: world.group.id, seq: 30 },
    ]);

    await r.press(KEY.pageUp);
    await screenShows(r, "below");
    await world.send(world.group.id, "row 31");
    await until(
      () => world.listed(world.group.id)?.lastSeq === 31,
      10_000,
      "the new row",
    );
    await realDelay(200);
    await flush();
    expect(world.listed(world.group.id)?.readSeq).toBe(30);
    expect(askedFor(world.wire, "conversations.read")).toHaveLength(1);

    await r.press(KEY.bottom);
    await until(
      () => world.listed(world.group.id)?.readSeq === 31,
      10_000,
      "the read mark at 31",
    );
    expect(askedFor(world.wire, "conversations.read")).toEqual([
      { conversationId: world.group.id, seq: 30 },
      { conversationId: world.group.id, seq: 31 },
    ]);
  }, 60_000);
});
