import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  machineView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { ConversationList } from "./sidebar-tree";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({ navigate: rstest.fn() }));
rstest.mock("nuqs", () => ({
  parseAsString: {},
  useQueryState: () => [null],
}));
rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.navigate.mockClear();
});

const agents = [
  agentView({ id: "a1", name: "乐子人" }),
  agentView({ id: "a2", name: "装配检查" }),
];
const projects = [
  projectView({ id: "p-eta", name: "eta", path: "/Users/me/Desktop/eta" }),
  projectView({ id: "p-house", name: "house", path: "/Users/me/work/house" }),
  projectView({
    id: "home-a1",
    name: "乐子人",
    path: "/data/agents/a1",
    kind: "agent_home",
  }),
];

const group = (
  id: string,
  name: string,
  projectId: string,
  extra: Partial<ConversationSummary> = {},
) =>
  conversationView({
    id,
    name,
    projectId,
    participants: [memberView("a1"), memberView("a2")],
    lastMessageAt: Date.now() - 60_000,
    ...extra,
  });

const direct = (
  id: string,
  name: string,
  agentId: string,
  extra: Partial<ConversationSummary> = {},
) =>
  conversationView({
    id,
    name,
    kind: "direct",
    projectId: `home-${agentId}`,
    participants: [memberView(agentId)],
    lastMessageAt: Date.now() - 60_000,
    ...extra,
  });

async function tree(
  conversations: ConversationSummary[],
  machines = [machineView({ id: "m1", name: "这台" })],
) {
  const host = productHost({ agents, projects, machines, conversations });
  const mounted = await mount(
    <SidebarProvider>
      <ConversationList />
    </SidebarProvider>,
  );
  await flush();
  return { ...mounted, host };
}

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-sidebar="menu-button"]')].map((row) =>
    row.getAttribute("title"),
  );

describe("侧边栏的对话列表", () => {
  it("mixes private chats and groups in one list, newest activity first", async () => {
    const now = Date.now();
    const { container } = await tree([
      group("g1", "装配", "p-eta", { lastMessageAt: now - 3 * 3_600_000 }),
      direct("d1", "乐子人", "a1", { lastMessageAt: now - 60_000 }),
      group("g2", "装修", "p-house", { lastMessageAt: now - 2 * 60_000 }),
      // No message yet: it is placed by when it was last touched.
      direct("d2", "装配检查", "a2", {
        lastMessageAt: null,
        updatedAt: now - 3_600_000,
      }),
    ]);
    expect(rowNames(container)).toEqual(["乐子人", "装修", "装配检查", "装配"]);
    // One list: no project headings and no private-chat section.
    expect(
      container.querySelectorAll('[data-sidebar="group-label"]'),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("私聊");
    expect(container.textContent).not.toContain("house");
  });

  it("hides archived conversations", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "旧的", "p-eta", { archived: true }),
    ]);
    expect(rowNames(container)).toEqual(["装配"]);
  });

  it("starts a conversation from the one + on the list heading", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const adds = container.querySelectorAll('button[title="新对话"]');
    expect(adds).toHaveLength(1);
    await click(adds[0]);
    expect(navigation.navigate).toHaveBeenCalledWith({ to: "/new" });
  });

  it("opens a conversation when its row is clicked", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    await click(button(container, "装配"));
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g1", view: "context" },
    });
  });

  it("shows members when expanded, and a member row focuses that agent in the group", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    expect(button(container, "乐子人")).toBeUndefined();
    await click(container.querySelector('[aria-label="展开成员"]'));
    await click(button(container, "乐子人"));
    // A member listed under a group is a member of that group: pressing it narrows the
    // conversation to it, rather than starting a separate private chat.
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g1", view: "context" },
    });
    expect(useWorkspaceStore.getState().focusedAgentId).toBe("a1");
  });

  it("marks who is answering and how much is unread", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta", {
        unread: 3,
        participants: [
          memberView("a1"),
          memberView("a2", { status: "working" }),
        ],
      }),
    ]);
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("●");
  });

  it("shows a private chat as its agent, with no members to expand", async () => {
    const { container } = await tree([direct("d1", "乐子人", "a1")]);
    expect(container.textContent).toContain("乐子人");
    expect(container.querySelector('[aria-label="展开成员"]')).toBeNull();
  });

  it("archives and renames through conversations.update, but cannot delete", async () => {
    const { container, host } = await tree([group("g1", "装配", "p-eta")]);
    host.handle("conversations.update", () => ({}));
    const menu = container.querySelector('[aria-label="群操作"]')!;
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["改名", "归档"]);
    await click(items[1]);
    await flush();
    expect(host.calls.find((call) => call.action === "update")?.args).toEqual({
      conversationId: "g1",
      archived: true,
    });
  });
});
