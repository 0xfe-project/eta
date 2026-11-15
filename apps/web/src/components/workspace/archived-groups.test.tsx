import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { conversationView, productHost } from "@/test-product";
import { button, cleanup, mount } from "@/test-render";
import { ArchivedGroups, GroupList } from "./groups";
import { useWorkspaceStore } from "./workspace-store";

const groups = rstest.hoisted(() => ({
  list: [] as ConversationSummary[],
}));
const navigation = rstest.hoisted(() => ({ open: rstest.fn() }));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: groups.list }),
  useOpenGroup: () => navigation.open,
}));

const group = (id: string, name: string, archived: boolean) =>
  conversationView({ id, name, archived });

let host: ReturnType<typeof productHost>;
async function render(node: React.ReactNode) {
  host = productHost({ conversations: groups.list });
  host.handle("conversations.update", () => ({}));
  return (await mount(node)).container;
}

afterEach(async () => {
  await cleanup();
  navigation.open.mockClear();
  setWire(undefined);
});

describe("已归档的对话", () => {
  it("are left out of the sidebar, which has no way to them", async () => {
    groups.list = [group("g1", "发布计划", false), group("g2", "旧讨论", true)];
    const container = await render(<GroupList />);
    expect(container.textContent).toContain("发布计划");
    expect(container.textContent).not.toContain("旧讨论");
    expect(button(container, "已归档")).toBeUndefined();
  });

  it("are listed in settings, to open (closing settings) or bring back", async () => {
    groups.list = [group("g1", "发布计划", false), group("g2", "旧讨论", true)];
    useWorkspaceStore
      .getState()
      .setSettings({ open: true, section: "archived" });
    const container = await render(<ArchivedGroups />);
    expect(container.textContent).not.toContain("发布计划");
    await act(async () => button(container, "旧讨论")!.click());
    expect(navigation.open).toHaveBeenCalledWith("g2");
    expect(useWorkspaceStore.getState().settings.open).toBe(false);
    await act(async () => button(container, "取消归档")!.click());
    expect(host.calls.find((call) => call.action === "update")?.args).toEqual({
      conversationId: "g2",
      archived: false,
    });
  });

  it("say so when there are none", async () => {
    groups.list = [group("g1", "发布计划", false)];
    const container = await render(<ArchivedGroups />);
    expect(container.textContent).toContain("没有已归档的对话");
  });
});
