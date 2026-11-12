/**
 * `/invite`, `/remove` and `/steward` without an argument: the choice layer, what it lists, the
 * current steward marked, and the host's state after Enter.
 */
import type { RenderedApp } from "../ui-support/app";
import { describe, expect, it } from "vitest";
import { screenShows } from "../conversation/view-host-world";
import { until } from "../support/temp";
import { KEYS, plain } from "../ui-support/render";
import { askedStarting, enter, manageWorld } from "./world";

async function group() {
  const world = await manageWorld();
  const ada = await world.agent("Ada");
  const ben = await world.agent("Ben");
  const cleo = await world.agent("Cleo");
  const dora = await world.agent("Dora");
  const project = await world.project(ada.id);
  const chat = await world.conversation(
    project.id,
    [ada.id, ben.id],
    "Release notes",
  );
  return { ...world, ada, ben, cleo, dora, project, chat };
}

/** The layer's lines: between its title and its footer. */
function layerLines(r: RenderedApp, title: string): string[] {
  const lines = plain(r).split("\n");
  const start = lines.findIndex((line) => line.includes(title));
  return start === -1 ? [] : lines.slice(start + 1);
}

/** The line holding `text`, trimmed of the layer's border. */
function lineWith(r: RenderedApp, text: string): string {
  return (
    plain(r)
      .split("\n")
      .find((line) => line.includes(text))
      ?.replace(/[│┌┐└┘─]/g, "")
      .trim() ?? ""
  );
}

describe("/invite without a name", () => {
  it("lists the agents who are not members and invites the one chosen", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/invite");
    await screenShows(r, "Invite to Release notes");
    const lines = layerLines(r, "Invite to Release notes").join("\n");
    expect(lines).toContain("Cleo");
    expect(lines).toContain("Dora");
    expect(lines).not.toMatch(/\bAda\b/);
    expect(lines).not.toMatch(/\bBen\b/);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await until(
      () =>
        w
          .listed(w.chat.id)
          ?.participants.some((p) => p.agentId === w.dora.id) === true,
      10_000,
      "Dora in the conversation",
    );
    await screenShows(r, "Invited Dora to Release notes");
    expect(plain(r)).not.toContain("Invite to Release notes");
    expect(askedStarting(w.wire, "conversations.invite")).toEqual([
      {
        op: "conversations.invite",
        args: { conversationId: w.chat.id, agentId: w.dora.id },
      },
    ]);
  }, 60_000);

  it("shows the host's refusal from the layer in the status area", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    w.failOn("conversations.invite", "the host is busy");
    await enter(r, "/invite");
    await screenShows(r, "Invite to Release notes");
    await r.press(KEYS.enter);
    await screenShows(r, "the host is busy");
  }, 60_000);
});

describe("/remove without a name", () => {
  it("lists the members and takes out the one chosen", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/remove");
    await screenShows(r, "Remove from Release notes");
    const lines = layerLines(r, "Remove from Release notes").join("\n");
    expect(lines).toContain("Ada");
    expect(lines).toContain("Ben");
    expect(lines).not.toContain("Cleo");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await until(
      () =>
        w
          .listed(w.chat.id)
          ?.participants.every((p) => p.agentId !== w.ben.id) === true,
      10_000,
      "Ben gone",
    );
    await screenShows(r, "Removed Ben from Release notes");
  }, 60_000);
});

describe("/steward without an argument", () => {
  it("lists the members, following the project and no steward, marking following as current", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/steward");
    await screenShows(r, "(current)");
    expect(lineWith(r, "Follow the project's steward")).toContain("(current)");
    expect(lineWith(r, "Ada")).not.toContain("(current)");
    expect(lineWith(r, "No steward")).not.toContain("(current)");
    const lines = layerLines(r, "Steward of Release notes").join("\n");
    expect(lines).not.toContain("Cleo");
    expect(lines.indexOf("Ada")).toBeLessThan(lines.indexOf("Ben"));
    expect(lines.indexOf("Ben")).toBeLessThan(
      lines.indexOf("Follow the project's steward"),
    );
    expect(lines.indexOf("Follow the project's steward")).toBeLessThan(
      lines.indexOf("No steward"),
    );
  }, 60_000);

  it("marks the conversation's own steward as current, and makes the one chosen steward", async () => {
    const w = await group();
    await w.raw.call("conversations", "setSteward", {
      conversationId: w.chat.id,
      agentId: w.ben.id,
    });
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/steward");
    await screenShows(r, "(current)");
    expect(lineWith(r, "Ben")).toContain("(current)");
    expect(lineWith(r, "Follow the project's steward")).not.toContain(
      "(current)",
    );
    // Ada is the first line.
    await r.press(KEYS.enter);
    await until(
      async () =>
        (await w.infoOf(w.chat.id)).stewardOverrideId === w.ada.id ||
        (await w.infoOf(w.chat.id)).stewardId === w.ada.id,
      10_000,
      "Ada as steward",
    );
    await screenShows(r, "Ada is the steward of Release notes now");
    expect(askedStarting(w.wire, "conversations.setSteward")).toEqual([
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: w.ada.id },
      },
    ]);
  }, 60_000);

  it("marks no steward as current, and follows the project when that is chosen", async () => {
    const w = await group();
    await w.raw.call("conversations", "setSteward", {
      conversationId: w.chat.id,
      agentId: null,
      none: true,
    });
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/steward");
    await screenShows(r, "(current)");
    expect(lineWith(r, "No steward")).toContain("(current)");
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, "Release notes follows its project's steward now");
    await until(
      async () => {
        const info = await w.infoOf(w.chat.id);
        return !info.noSteward && info.stewardOverrideId === null;
      },
      10_000,
      "following the project",
    );
    expect(askedStarting(w.wire, "conversations.setSteward")).toEqual([
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: null },
      },
    ]);
  }, 60_000);

  it("sets no steward from the last line", async () => {
    const w = await group();
    const r = await w.showFront(w.chat.id);
    await w.agentsArrived(4);
    await enter(r, "/steward");
    await screenShows(r, "Steward of Release notes");
    for (let i = 0; i < 3; i += 1) await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, "Release notes has no steward now");
    expect(askedStarting(w.wire, "conversations.setSteward")).toEqual([
      {
        op: "conversations.setSteward",
        args: { conversationId: w.chat.id, agentId: null, none: true },
      },
    ]);
  }, 60_000);
});
