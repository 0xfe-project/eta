/**
 * The conversation commands typed into the interface on a real host: `/queue`, `/steer` and
 * `/stop` act on the conversation in front, and are refused when the front is not one; `/open`
 * says why it opened nothing.
 */
import type {
  HistoryResult,
  MessageView,
  SendResult,
} from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import {
  holdNextDelivery,
  uploadNote,
} from "../../../eta/test/support/briefing";
import { gate, HANG, say } from "../../../eta/test/support/models";
import { wireUrl } from "../../src/connection/address";
import { Wire } from "../../src/connection/wire";
import { conversationList } from "../../src/ext/conversation/facts";
import { baseUrl } from "../support/host";
import { until } from "../support/temp";
import { KEYS, plain } from "../ui-support/render";
import { askedFor, hostWorld, screenShows, withAda } from "./view-host-world";

const REPLYING = "Ada is replying";

/** The status area: the row above the tab bar. */
const statusLine = (r: { lastFrame: () => string }) =>
  plain(r).split("\n").at(-2) ?? "";

async function enter(
  r: {
    type: (t: string) => Promise<void>;
    press: (k: string) => Promise<void>;
  },
  line: string,
) {
  await r.type(line);
  await r.press(KEYS.enter);
}

describe("with a conversation in front", () => {
  it("/steer joins the reply, /queue waits behind it, /stop stops it", async () => {
    const world = await withAda((request) =>
      request.index === 0 ? HANG : say("a later answer"),
    );
    const sent = await world.send(world.group.id, "start working");
    const reply = sent.replies[0]!.id;
    const r = await world.showConversation(world.group.id);
    await screenShows(r, REPLYING);

    await enter(r, "/steer go right");
    // Drawn in the message whose turn it joined, as the client's Insert block.
    await screenShows(r, "Inserted · ");
    expect(askedFor(world.wire, "conversations.send")).toEqual([
      {
        conversationId: world.group.id,
        text: "go right",
        mentions: [],
        mode: "steer",
        clientId: expect.any(String),
      },
    ]);
    const steered = await world.rowWhere(
      world.group.id,
      (row) => row.text === "go right",
    );
    expect(steered?.data.joined).toEqual([world.ada.id]);
    expect(steered?.data.into).toBe(sent.message.id);

    await enter(r, "/queue @Ada after this");
    await screenShows(r, "⧗ @Ada after this");
    expect(askedFor(world.wire, "conversations.send")[1]).toEqual({
      conversationId: world.group.id,
      text: "@Ada after this",
      mentions: [world.ada.id],
      mode: "queue",
      clientId: expect.any(String),
    });

    await enter(r, "/stop");
    await until(
      async () =>
        (await world.rowWhere(world.group.id, (row) => row.id === reply))
          ?.status === "stopped",
      20_000,
      "the stop",
    );
    expect(askedFor(world.wire, "conversations.stop")).toEqual([
      { conversationId: world.group.id },
    ]);
    await screenShows(r, "■ Stopped");
  }, 60_000);

  it("/steer into a reply that ends while it is being briefed is answered as a reply of its own, once", async () => {
    const first = gate();
    let adaAsked = 0;
    const world = await hostWorld(async (request) => {
      if (request.agent === "Ben") return say("got the file");
      adaAsked += 1;
      if (adaAsked === 1) {
        await first.opened;
        return say("on it");
      }
      return say("going right");
    });
    const ada = await world.agent("Ada");
    const ben = await world.agent("Ben");
    const project = await world.project();
    const group = await world.conversation(project.id, [ada.id, ben.id]);
    const sent = await world.send(group.id, "start working");
    const reply = sent.replies[0]!.id;
    await until(() => adaAsked === 1, 20_000, "Ada's first request");
    // A file Ada has not seen yet: her next briefing puts it in place, and is held there.
    const note = await uploadNote(world.raw, group.id);
    const toBen = await world.raw.call<SendResult>("conversations", "send", {
      conversationId: group.id,
      text: "@Ben have a look",
      mentions: [ben.id],
      attachments: [note],
    });
    await until(
      async () =>
        (
          await world.rowWhere(
            group.id,
            (row) => row.id === toBen.replies[0]!.id,
          )
        )?.status === "done",
      20_000,
      "Ben's reply",
    );
    const r = await world.showConversation(group.id);
    await screenShows(r, REPLYING);

    // The interface's wire waits on the send it is held in, so the test watches from its own.
    const aside = new Wire({ url: wireUrl(baseUrl(world.host)) });
    aside.connect();
    const row = async (found: (row: MessageView) => boolean) =>
      (
        await aside.call<HistoryResult>("conversations", "history", {
          conversationId: group.id,
          limit: 100,
        })
      ).messages.find(found);

    const hold = holdNextDelivery();
    await enter(r, "/steer go right");
    await hold.reached;
    first.open();
    try {
      await until(
        async () =>
          aside.store.getState().status === "open" &&
          (await row((it) => it.id === reply))?.status === "done",
        20_000,
        "the first reply",
      );
    } finally {
      aside.close();
    }
    hold.release();

    // Not joined: a reply of its own, which carries the answer.
    await until(
      async () =>
        (await world.rowWhere(group.id, (row) => row.text === "going right"))
          ?.status === "done",
      20_000,
      "the answer to the steer",
    );
    const steered = await world.rowWhere(
      group.id,
      (row) => row.text === "go right",
    );
    expect(steered?.data).toMatchObject({ joined: [], woke: [ada.id] });
    expect(
      (await world.rows(group.id)).filter((row) => row.text === "go right"),
    ).toHaveLength(1);
    expect(
      world.requests.filter((request) =>
        request.transcript.join("\n").includes("go right"),
      ),
    ).toHaveLength(1);
  }, 60_000);

  it("/queue and /steer without a message say how to use them and send nothing", async () => {
    const world = await withAda(() => say("ok"));
    const r = await world.showConversation(world.group.id);
    await screenShows(r, "Write a message");
    await enter(r, "/queue");
    await screenShows(r, "Usage: /queue <message>");
    await enter(r, "/steer");
    await screenShows(r, "Usage: /steer <message>");
    expect(askedFor(world.wire, "conversations.send")).toEqual([]);
  }, 60_000);
});

describe("/open", () => {
  it("lists the names it could mean when several match", async () => {
    const world = await hostWorld(() => say("ok"));
    const ada = await world.agent("Ada");
    const project = await world.project();
    await world.conversation(project.id, [ada.id], "Release notes");
    await world.conversation(project.id, [ada.id], "Release planning");
    const r = await world.show({ tabs: [], activeTab: undefined });
    await until(
      () => conversationList(world.raw.store.getState()).length === 2,
      10_000,
      "the list",
    );
    await enter(r, "/open release");
    await screenShows(r, "Release planning");
    expect(statusLine(r)).toContain("Release notes");
    expect(statusLine(r)).toContain("Release planning");
    expect(plain(r).split("\n").at(-1)).not.toContain("1:");
  }, 60_000);

  it("says when nothing matches, and how to use it without an argument", async () => {
    const world = await withAda(() => say("ok"), "Release notes");
    const r = await world.show({ tabs: [], activeTab: undefined });
    await enter(r, "/open zebra");
    await screenShows(r, "No conversation called zebra");
    await enter(r, "/open");
    await screenShows(r, "Usage: /open <conversation>");
    expect(plain(r).split("\n").at(-1)).not.toContain("1:");
  }, 60_000);
});
