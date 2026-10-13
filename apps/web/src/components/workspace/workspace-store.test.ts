import { beforeEach, describe, expect, it } from "@rstest/core";
import { useWorkspaceStore } from "./workspace-store";

const key = "axp.workspace.v1";
const saved = { tasks: [], lastModel: "m1" };

describe("workspace store persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({
      workspace: { tasks: [] },
    });
  });

  it("loads the bare object saved before the store existed", async () => {
    // Fields no longer kept (the old local memory notes) are dropped.
    localStorage.setItem(key, JSON.stringify({ ...saved, memory: "notes" }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(saved);
  });

  for (const sessionTheme of ["codex", "grok", "claude"]) {
    it(`discards retired ${sessionTheme} appearance and preserves other preferences`, async () => {
      localStorage.setItem(
        key,
        JSON.stringify({ ...saved, sessionTheme, fontSans: "Arial" }),
      );
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toEqual({
        ...saved,
        fontSans: "Arial",
      });
      useWorkspaceStore.getState().setWorkspace((w) => ({ ...w }));
      expect(JSON.parse(localStorage.getItem(key)!)).not.toHaveProperty(
        "sessionTheme",
      );
    });
  }

  it("ignores saved data that does not validate", async () => {
    localStorage.setItem(key, JSON.stringify({ sessionTheme: "nope" }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({ tasks: [] });
  });

  it("remembers how the task page was left", async () => {
    const page = { taskLayout: "board", taskScope: "remote" };
    localStorage.setItem(key, JSON.stringify({ ...saved, ...page }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toMatchObject(page);
  });

  it("saves the bare workspace object, not other UI state", () => {
    const { setWorkspace, setMobilePanel } = useWorkspaceStore.getState();
    setWorkspace((w) => ({ ...w, selectedAgentId: "a1" }));
    setMobilePanel("workspace");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      tasks: [],
      selectedAgentId: "a1",
    });
  });
});
