import { beforeEach, describe, expect, it } from "@rstest/core";
import { useWorkspaceStore } from "./workspace-store";

const key = "eta.workspace.v1";
const saved = { lastModel: "m1" };

describe("workspace store persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: {} });
  });

  it("drops fields it does not keep and preserves the rest", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, sessionTheme: "codex", unknownField: 1 }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({
      ...saved,
    });
  });

  it("ignores saved data that does not validate", async () => {
    localStorage.setItem(key, JSON.stringify({ selectedGroupId: 5 }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({});
  });

  it("drops the list or board saved before the page was only a board", async () => {
    const kept = {
      selectedGroupId: "g1",
      selectedAgentId: "a1",
      lastModel: "m1",
      reactGrab: true,
      transcriptRail: true,
      chatWidth: "narrow",
      agentsCollapsed: true,
      recentDirectories: { m1: ["/code/eta"] },
    };
    for (const taskLayout of ["list", "board"]) {
      localStorage.setItem(key, JSON.stringify({ ...kept, taskLayout }));
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toEqual(kept);
    }
  });

  it("remembers the chat's rail switched on across a reload", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, transcriptRail: true }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toMatchObject({
      transcriptRail: true,
    });
  });

  it("remembers the chat's content width across a reload", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, chatWidth: "extra-narrow" }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace.chatWidth).toBe(
      "extra-narrow",
    );
  });

  it("drops a task scope saved before the board had none", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, taskScope: "remote" }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({
      ...saved,
    });
  });

  it("has no folded panel to remember: the wide layout always shows it", async () => {
    // et-old's right column is always there from `lg` up; the drawer is a phone thing, and
    // `mobilePanel` is all it needs.
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, panelCollapsed: true }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(saved);
    useWorkspaceStore.getState().showPanel();
    expect(useWorkspaceStore.getState().mobilePanel).toBe("workspace");
  });

  it("saves the bare workspace object, not other UI state", () => {
    const { setWorkspace, setMobilePanel } = useWorkspaceStore.getState();
    setWorkspace((w) => ({ ...w, selectedAgentId: "a1" }));
    setMobilePanel("workspace");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      selectedAgentId: "a1",
    });
  });
});
