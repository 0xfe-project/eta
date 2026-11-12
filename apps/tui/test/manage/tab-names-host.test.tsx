/**
 * Two conversation tabs of the same name on a real host: the tab bar tells them apart by steward,
 * then by the start of the id, and follows a changed steward and a rename.
 */
import { describe, expect, it } from "vitest";
import { CONVERSATION_VIEW } from "../../src/ext/conversation/kind";
import { screenShows } from "../conversation/view-host-world";
import { KEYS } from "../ui-support/render";
import { manageWorld, tabBar } from "./world";

async function twoNamedAlike() {
  const w = await manageWorld();
  const ada = await w.agent("Ada");
  const ben = await w.agent("Ben");
  const project = await w.project(ada.id);
  const first = await w.conversation(project.id, [ada.id], "demo");
  const second = await w.conversation(project.id, [ada.id, ben.id], "demo");
  const r = await w.show({
    tabs: [
      { kind: CONVERSATION_VIEW, id: first.id },
      { kind: CONVERSATION_VIEW, id: second.id },
    ],
    activeTab: 0,
  });
  const ask = (action: string, args: Record<string, unknown>) =>
    w.raw.call("conversations", action, args);
  return { w, r, ada, ben, first, second, ask };
}

const bar = (text: string) => (screen: string) =>
  (screen.split("\n").at(-1) ?? "").includes(text);

describe("conversation tabs of the same name", () => {
  it("go by steward, then by id when the steward is the same, and lose the qualifiers once renamed", async () => {
    const { r, ada, ben, first, second, ask } = await twoNamedAlike();
    await ask("setSteward", { conversationId: second.id, agentId: ben.id });
    await screenShows(r, bar("1:demo (Ada)  2:demo (Ben)"));

    await ask("setSteward", { conversationId: second.id, agentId: ada.id });
    await screenShows(
      r,
      bar(
        `1:demo (Ada · ${first.id.slice(0, 6)})  2:demo (Ada · ${second.id.slice(0, 6)})`,
      ),
    );

    await ask("update", { conversationId: second.id, name: "other" });
    await screenShows(r, bar("1:demo  2:other"));
    expect(tabBar(r)).not.toContain("(");
  }, 60_000);

  it("goes by id for a conversation without a steward", async () => {
    const { r, second, ask } = await twoNamedAlike();
    await ask("setSteward", {
      conversationId: second.id,
      agentId: null,
      none: true,
    });
    await screenShows(
      r,
      bar(`1:demo (Ada)  2:demo (${second.id.slice(0, 6)})`),
    );
  }, 60_000);

  it("drops the qualifier of the tab left once the other is closed", async () => {
    const { r, ben, second, ask } = await twoNamedAlike();
    await ask("setSteward", { conversationId: second.id, agentId: ben.id });
    await screenShows(r, bar("1:demo (Ada)  2:demo (Ben)"));
    await r.press(KEYS.ctrlW); // tabs.close in the test settings
    // Times out while the tab left keeps its qualifier.
    await screenShows(
      r,
      (screen) => !bar("2:demo")(screen) && !bar("(")(screen),
      10_000,
    );
    expect(tabBar(r)).toMatch(/^1:demo {2}/);
  }, 60_000);
});
