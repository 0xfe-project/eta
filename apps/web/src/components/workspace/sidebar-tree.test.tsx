import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
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
import { ProjectTree } from "./sidebar-tree";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({
  open: rstest.fn(),
  navigate: rstest.fn(),
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => navigation.open,
}));
rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.open.mockClear();
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

async function tree(
  conversations: ConversationSummary[],
  query = "",
  machines = [machineView({ id: "m1", name: "这台" })],
) {
  const host = productHost({ agents, projects, machines, conversations });
  const mounted = await mount(<ProjectTree query={query} />);
  await flush();
  return { ...mounted, host };
}

describe("侧边栏的树", () => {
  it("heads each project and puts its conversations underneath", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "装修", "p-house"),
    ]);
    const headings = [...container.querySelectorAll("h3")].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["eta", "house"]);
  });

  it("keeps a project with nothing in it, so there is a + to start in", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const headings = [...container.querySelectorAll("h3")].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["eta", "house"]);
    await click(
      container.querySelector(
        'section[aria-label="house"] button[title="新对话"]',
      ),
    );
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/new",
      search: { project: "p-house" },
    });
  });

  it("opens a conversation when its row is clicked", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    await click(button(container, "装配"));
    expect(navigation.open).toHaveBeenCalledWith("g1");
  });

  it("shows members when expanded, and a member row focuses that agent in the group", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    expect(button(container, "乐子人")).toBeUndefined();
    await click(container.querySelector('[aria-label="展开成员"]'));
    await click(button(container, "乐子人"));
    // A member listed under a group is a member of that group: pressing it narrows the
    // conversation to it, rather than starting a separate private chat.
    expect(navigation.open).toHaveBeenCalledWith("g1");
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

  it("puts private chats in a section of their own, as rows named after the agent", async () => {
    const { container } = await tree([
      group("d1", "乐子人", "home-a1", {
        kind: "direct",
        participants: [memberView("a1")],
      }),
      group("g1", "装配", "p-eta"),
    ]);
    const headings = [...container.querySelectorAll("h3")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["私聊", "eta", "house"]);
    expect(container.textContent).toContain("乐子人");
    // A private chat has no members to show: its name *is* the agent.
    const direct = container.querySelector('section[aria-label="私聊"]')!;
    expect(direct.querySelector('[aria-label="展开成员"]')).toBeNull();
    expect(direct.querySelector('button[title="新对话"]')).toBeNull();
  });

  it("does not head the projects with a machine while there is only one", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    expect(container.querySelector("h2")).toBeNull();
  });

  it("groups the projects by machine once there is more than one", async () => {
    const { container } = await tree(
      [group("g1", "装配", "p-eta"), group("g2", "装修", "p-far")],
      "",
      [
        machineView({ id: "m1", name: "这台" }),
        machineView({ id: "m2", name: "远端", kind: "daemon" }),
      ],
    ).then(async (result) => {
      await act(async () =>
        result.host.set("projects", {
          list: [
            ...projects,
            projectView({
              id: "p-far",
              name: "far",
              path: "/srv/far",
              machineId: "m2",
            }),
          ],
        }),
      );
      return result;
    });
    const machineNames = [...container.querySelectorAll("h2")].map(
      (h) => h.textContent,
    );
    expect(machineNames).toEqual(["这台", "远端"]);
    const remote = [...container.querySelectorAll("h2")][1]!.parentElement!;
    expect(remote.textContent).toContain("far");
    expect(remote.textContent).not.toContain("eta");
  });

  it("filters locally by name, project or member", async () => {
    const { container } = await tree(
      [group("g1", "装配", "p-eta"), group("g2", "装修", "p-house")],
      "house",
    );
    expect(container.textContent).toContain("装修");
    expect(container.textContent).not.toContain("装配");
  });

  it("falls back to a sentence when a search matches nothing", async () => {
    const { container } = await tree(
      [group("g1", "装配", "p-eta")],
      "没有这个",
    );
    expect(container.textContent).toContain("没有匹配的对话");
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
