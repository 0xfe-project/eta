import { beforeEach, describe, expect, it } from "@rstest/core";
import { useWorkspaceStore } from "./workspace-store";

const key = "axp.workspace.v1";
const saved = { tasks: [], memory: "", sessionTheme: "grok", lastModel: "m1" };

describe("workspace store persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({
      workspace: { tasks: [], memory: "", sessionTheme: "claude" },
    });
  });

  it("loads the bare object saved before the store existed", async () => {
    localStorage.setItem(key, JSON.stringify(saved));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(saved);
  });

  it("ignores saved data that does not validate", async () => {
    localStorage.setItem(key, JSON.stringify({ sessionTheme: "nope" }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace.sessionTheme).toBe("claude");
  });

  it("saves the bare workspace object, not other UI state", () => {
    const { setWorkspace, setDraft } = useWorkspaceStore.getState();
    setWorkspace((w) => ({ ...w, selectedAgentId: "a1" }));
    setDraft("unsent text");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      tasks: [],
      memory: "",
      sessionTheme: "claude",
      selectedAgentId: "a1",
    });
  });
});
