/**
 * A conversation tab's done and failed marks on a real host: they come for a tab that is not in
 * front too, and go once the conversation is read.
 */
import { describe, expect, it } from "vitest";
import { say } from "../../../eta/test/support/models";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { screenShows } from "../conversation/view-host-world";
import { until } from "../support/temp";
import { KEYS } from "../ui-support/render";
import { manageWorld, tabBar } from "./world";

async function twoTabs(respond: Parameters<typeof manageWorld>[0]) {
  const w = await manageWorld(respond);
  const ada = await w.agent("Ada");
  const project = await w.project(ada.id);
  const front = await w.conversation(project.id, [ada.id], "Front");
  const behind = await w.conversation(project.id, [ada.id], "Behind");
  const r = await w.show({
    tabs: [
      { kind: CONVERSATION_VIEW, id: front.id },
      { kind: CONVERSATION_VIEW, id: behind.id },
    ],
    activeTab: 0,
  });
  await screenShows(r, "2:Behind");
  return { w, r, ada, front, behind };
}

describe("done and failed marks", () => {
  it("marks a tab behind the front one done when its reply ends, and drops the mark once read", async () => {
    const { w, r, behind } = await twoTabs(() => say("all finished"));
    await w.send(behind.id, "please do it");
    await until(
      async () =>
        (await w.rowWhere(behind.id, (row) => row.author === "agent"))
          ?.status === "done",
      20_000,
      "the reply",
    );
    await screenShows(r, (screen) => /2:Behind ✓/.test(screen));
    expect(tabBar(r)).not.toMatch(/1:Front [✓✗]/);
    // In front and scrolled to the bottom, the view marks it read.
    await r.press(KEYS.altRight);
    await screenShows(r, "all finished");
    await screenShows(
      r,
      (screen) => !/2:Behind ✓/.test(screen.split("\n").at(-1) ?? ""),
    );
    expect(tabBar(r)).toContain("2:Behind");
  }, 60_000);

  it("marks a tab behind the front one failed when its reply fails", async () => {
    const { w, r, behind } = await twoTabs(() => {
      throw new Error("the model broke");
    });
    await w.send(behind.id, "please do it");
    await until(
      async () =>
        (await w.rowWhere(behind.id, (row) => row.author === "agent"))
          ?.status === "failed",
      20_000,
      "the failure",
    );
    await screenShows(r, (screen) => /2:Behind ✗/.test(screen));
  }, 60_000);
});
