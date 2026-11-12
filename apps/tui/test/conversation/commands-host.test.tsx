/**
 * The conversation commands typed into the interface on a real host: `/queue`, `/steer` and
 * `/stop` act on the conversation in front, and are refused when the front is not one; `/open`
 * says why it opened nothing.
 */
import { describe, expect, it } from "vitest";
import { HANG, say } from "../../../eta/test/support/models";
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
    await screenShows(r, "Joined Ada's reply");
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
    const project = await world.project(ada.id);
    await world.conversation(project.id, [ada.id], "Release notes");
    await world.conversation(project.id, [ada.id], "Release planning");
    const r = await world.show({ tabs: [], activeTab: undefined });
    await until(
      () =>
        (
          world.raw.store.getState().targets.conversations?.sections.list as
            | unknown[]
            | undefined
        )?.length === 2,
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
