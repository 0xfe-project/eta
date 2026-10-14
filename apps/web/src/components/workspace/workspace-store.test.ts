import { beforeEach, describe, expect, it } from "@rstest/core";
import { useWorkspaceStore } from "./workspace-store";

const key = "axp.workspace.v1";
const saved = { lastModel: "m1" };

describe("workspace store persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: {} });
  });

  it("drops fields it does not keep and preserves the rest", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ ...saved, sessionTheme: "codex", fontSans: "Arial" }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({
      ...saved,
      fontSans: "Arial",
    });
  });

  it("ignores saved data that does not validate", async () => {
    localStorage.setItem(key, JSON.stringify({ fontSans: 5 }));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual({});
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
      selectedAgentId: "a1",
    });
  });
});
