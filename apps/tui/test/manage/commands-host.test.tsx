/**
 * `/rename`, `/archive`, `/unarchive`, `/invite`, `/remove` and `/steward` typed into the
 * interface on a real host, with their arguments: what the host holds afterwards, what the status
 * area says, and the tabs that open and close.
 */
import { describe, expect, it } from "vitest";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { screenShows } from "../conversation/view-host-world";
import { until } from "../support/temp";
import { plain, realDelay } from "../ui-support/render";
import { askedStarting, enter, manageWorld, statusLine, tabBar } from "./world";

/** Ada and Ben in a group named "Release notes" in a project whose steward is Ada; Cleo outside it. */
async function group() {
  const world = await manageWorld();
  const ada = await world.agent("Ada");
  const ben = await world.agent("Ben");
  const cleo = await world.agent("Cleo");
  const project = await world.project(ada.id);
  const chat = await world.conversation(
    project.id,
    [ada.id, ben.id],
    "Release notes",
  );
  return { ...world, ada, ben, cleo, project, chat };
}

const NO_FRONT = { tabs: [], activeTab: undefined };

describe("/rename", () => {
  it("renames the conversation in front on the host and says so", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await enter(r, "/rename  Launch plan ");
    await until(
      () => w.listed(w.chat.id)?.name === "Launch plan",
      10_000,
      "the new name",
    );
    await screenShows(r, "Renamed to Launch plan");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([
      {
        op: "conversations.update",
        args: { conversationId: w.chat.id, name: "Launch plan" },
      },
    ]);
    expect(tabBar(r)).toContain("1:Launch plan");
  }, 60_000);

  it("says how to use it for a blank name and asks nothing", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await enter(r, "/rename    ");
    await screenShows(r, "Usage: /rename <name>");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([]);
  }, 60_000);

  it("says to open a conversation first when none is in front", async () => {
    const w = await group();
    const r = await w.show(NO_FRONT);
    await enter(r, "/rename Other");
    await screenShows(r, "Open a conversation first");
    await realDelay(100);
    expect(askedStarting(w.wire, "conversations.")).toEqual([]);
    expect(w.listed(w.chat.id)?.name).toBe("Release notes");
  }, 60_000);

  it("shows the host's refusal in the status area", async () => {
    const w = await group();
    w.failOn("conversations.update", "a conversation needs a name");
    const r = await w.showFront(w.chat.id);
    await enter(r, "/rename Other");
    await screenShows(r, "a conversation needs a name");
    expect(statusLine(r)).toContain("a conversation needs a name");
    expect(w.listed(w.chat.id)?.name).toBe("Release notes");
  }, 60_000);
});

describe("/archive", () => {
  it("archives the conversation in front and closes its tab", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await screenShows(r, "1:Release notes");
    await enter(r, "/archive");
    await until(
      () => w.listed(w.chat.id)?.archived === true,
      10_000,
      "the archive",
    );
    await screenShows(r, "Archived Release notes");
    expect(tabBar(r)).not.toContain("Release notes");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([
      {
        op: "conversations.update",
        args: { conversationId: w.chat.id, archived: true },
      },
    ]);
  }, 60_000);

  it("archives the one conversation a name means, and closes its tab though another is in front", async () => {
    const w = await group();
    const other = await w.conversation(w.project.id, [w.ada.id], "Planning");
    const r = await w.show({
      tabs: [
        { kind: CONVERSATION_VIEW, id: other.id },
        { kind: CONVERSATION_VIEW, id: w.chat.id },
      ],
      activeTab: 0,
    });
    await screenShows(r, "2:Release notes");
    await enter(r, "/archive rel");
    await until(
      () => w.listed(w.chat.id)?.archived === true,
      10_000,
      "the archive",
    );
    await screenShows(r, "Archived Release notes");
    expect(tabBar(r)).toContain("1:Planning");
    expect(tabBar(r)).not.toContain("Release notes");
    expect(w.listed(other.id)?.archived).toBe(false);
  }, 60_000);

  it("lists the names it could mean, and says when none matches, archiving nothing", async () => {
    const w = await group();
    await w.conversation(w.project.id, [w.ada.id], "Release planning");
    const r = await w.show(NO_FRONT);
    await until(() => w.conversations().length === 2, 10_000, "the list");
    await enter(r, "/archive release");
    await screenShows(r, "Release planning");
    expect(statusLine(r)).toContain("Release notes");
    expect(statusLine(r)).toContain("Release planning");
    await enter(r, "/archive zebra");
    await screenShows(r, "No conversation called zebra");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([]);
  }, 60_000);

  it("does not find an archived conversation by name", async () => {
    const w = await group();
    await w.raw.call("conversations", "update", {
      conversationId: w.chat.id,
      archived: true,
    });
    const r = await w.show(NO_FRONT);
    await until(
      () => w.listed(w.chat.id)?.archived === true,
      10_000,
      "the archive",
    );
    await enter(r, "/archive Release notes");
    await screenShows(r, "No conversation called Release notes");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([]);
  }, 60_000);

  it("shows the host's refusal and keeps the tab", async () => {
    const w = await group();
    w.failOn("conversations.update", "the host is busy");
    const r = await w.showFront(w.chat.id);
    await screenShows(r, "1:Release notes");
    await enter(r, "/archive");
    await screenShows(r, "the host is busy");
    expect(tabBar(r)).toContain("1:Release notes");
    expect(w.listed(w.chat.id)?.archived).toBe(false);
  }, 60_000);
});

describe("/unarchive", () => {
  it("brings an archived conversation back and opens its tab", async () => {
    const w = await group();
    await w.raw.call("conversations", "update", {
      conversationId: w.chat.id,
      archived: true,
    });
    const r = await w.show(NO_FRONT);
    await until(
      () => w.listed(w.chat.id)?.archived === true,
      10_000,
      "the archive",
    );
    await enter(r, "/unarchive release");
    await until(
      () => w.listed(w.chat.id)?.archived === false,
      10_000,
      "the unarchive",
    );
    await screenShows(r, "Unarchived Release notes");
    await screenShows(r, "1:Release notes");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([
      {
        op: "conversations.update",
        args: { conversationId: w.chat.id, archived: false },
      },
    ]);
  }, 60_000);

  it("looks among the archived only, and needs an argument", async () => {
    const w = await group();
    const r = await w.show(NO_FRONT);
    await enter(r, "/unarchive Release notes");
    await screenShows(r, "No conversation called Release notes");
    await enter(r, "/unarchive");
    await screenShows(r, "Usage: /unarchive <conversation>");
    expect(askedStarting(w.wire, "conversations.update")).toEqual([]);
  }, 60_000);
});

describe("/invite with a name", () => {
  it("invites the agent the name means into the conversation in front", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);
    await enter(r, "/invite cl");
    await until(
      () =>
        w
          .listed(w.chat.id)
          ?.participants.some((p) => p.agentId === w.cleo.id) === true,
      10_000,
      "Cleo in the conversation",
    );
    await screenShows(r, "Invited Cleo to Release notes");
    expect(askedStarting(w.wire, "conversations.invite")).toEqual([
      {
        op: "conversations.invite",
        args: { conversationId: w.chat.id, agentId: w.cleo.id },
      },
    ]);
  }, 60_000);

  it("looks among those who are not members", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);
    await enter(r, "/invite Ben");
    await screenShows(r, "No agent called “Ben”");
    expect(askedStarting(w.wire, "conversations.invite")).toEqual([]);
  }, 60_000);

  it("refuses a private chat before asking the host", async () => {
    const w = await group();
    const direct = (
      await w.raw.call<{ conversation: { id: string } }>("agents", "direct", {
        agentId: w.ada.id,
      })
    ).conversation;
    const r = await w.showFront(direct.id);
    await w.agentsArrived(3);
    await until(() => w.listed(direct.id) !== undefined, 10_000, "the chat");
    await enter(r, "/invite Cleo");
    await screenShows(
      r,
      "A private chat is just the agent and you; members cannot be added or removed",
    );
    await enter(r, "/invite");
    await realDelay(100);
    expect(askedStarting(w.wire, "conversations.invite")).toEqual([]);
    expect(r.lastFrame()).not.toContain("Invite to");
  }, 60_000);
});

describe("/remove with a name", () => {
  it("takes the member the name means out of the conversation in front", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);
    await enter(r, "/remove ben");
    await until(
      () =>
        w
          .listed(w.chat.id)
          ?.participants.every((p) => p.agentId !== w.ben.id) === true,
      10_000,
      "Ben gone from the conversation",
    );
    await screenShows(r, "Removed Ben from Release notes");
  }, 60_000);

  it("looks among the members only", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);
    await enter(r, "/remove Cleo");
    await screenShows(r, "No agent called “Cleo”");
    expect(askedStarting(w.wire, "conversations.remove")).toEqual([]);
  }, 60_000);
});

describe("/steward with an argument", () => {
  it("makes a member the steward, then follows the project, then has none", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);

    await enter(r, "/steward Ben");
    await screenShows(r, "Ben is the steward of Release notes now");
    let info = await w.infoOf(w.chat.id);
    await until(
      async () => (await w.infoOf(w.chat.id)).stewardOverrideId === w.ben.id,
      10_000,
      "Ben as steward",
    );

    await enter(r, "/steward project");
    await screenShows(r, "Release notes follows its project's steward now");
    await until(
      async () => {
        info = await w.infoOf(w.chat.id);
        return info.stewardOverrideId === null && !info.noSteward;
      },
      10_000,
      "following the project",
    );
    expect(info.stewardId).toBe(w.ada.id);

    await enter(r, "/steward none");
    await screenShows(r, "Release notes has no steward now");
    await until(
      async () => (await w.infoOf(w.chat.id)).noSteward,
      10_000,
      "no steward",
    );

    expect(askedStarting(w.wire, "conversations.setSteward")).toEqual([
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: w.ben.id },
      },
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: null },
      },
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: null, none: true },
      },
    ]);
  }, 60_000);

  it("looks among the members only", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(3);
    await enter(r, "/steward Cleo");
    await screenShows(r, "No agent called “Cleo”");
    expect(askedStarting(w.wire, "conversations.setSteward")).toEqual([]);
  }, 60_000);
});

describe("before the conversation's details arrive", () => {
  it.each([["/invite"], ["/invite Cleo"], ["/remove"], ["/remove Ben"]])(
    "%s says to try again and asks nothing",
    async (line) => {
      const w = await group();
      const r = await w.showFront(w.chat.id);
      await w.agentsArrived(3);
      await screenShows(r, "Write a message");
      // The list as it is before the conversation is in it.
      const { conversations } = w.raw.store.getState().targets;
      w.raw.store.setState({
        targets: {
          ...w.raw.store.getState().targets,
          conversations: {
            ...conversations!,
            sections: { list: [] },
          },
        },
      });
      await enter(r, line);
      await screenShows(
        r,
        "The conversation's details have not arrived yet; try again in a moment",
      );
      await realDelay(50);
      expect(askedStarting(w.wire, "conversations.")).toEqual([]);
      expect(plain(r)).not.toContain("Invite to");
      expect(plain(r)).not.toContain("Remove from");
    },
    60_000,
  );
});
