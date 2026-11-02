import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { SidebarProvider } from "@/components/ui/sidebar";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import {
  agentView,
  buildProductHost,
  conversationView,
  machineView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { ConversationList } from "./sidebar-tree";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({ navigate: rstest.fn() }));
rstest.mock("nuqs", () => {
  const parser = ({ parse }: { parse: (value: string | null) => unknown }) => {
    const self = {
      parse,
      serialize: (value: unknown) => value,
      withDefault: () => self,
      withOptions: () => self,
    };
    return self;
  };
  return {
    createParser: parser,
    parseAsString: {},
    useQueryState: () => [null],
  };
});
rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  navigation.navigate.mockClear();
  useWorkspaceStore.setState({
    workspace: {},
    newConversation: { open: false },
  });
});

const agents = [
  agentView({
    id: "a1",
    name: "乐子人",
    persona: "INFJ",
    model: "p:m1",
  }),
  agentView({ id: "a2", name: "装配检查", persona: "", model: null }),
];
const projects = [
  projectView({ id: "p-eta", name: "eta", path: "/Users/me/Desktop/eta" }),
  // Outside the primary's home: nothing to shorten, so the path is the whole path.
  projectView({ id: "p-house", name: "house", path: "/srv/house" }),
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
  agentId: string,
  extra: Partial<ConversationSummary> = {},
) =>
  conversationView({
    id,
    name: agentId,
    kind: "direct",
    projectId: `home-${agentId}`,
    participants: [memberView(agentId)],
    lastMessageAt: Date.now() - 60_000,
    ...extra,
  });

async function tree(
  conversations: ConversationSummary[],
  { open = true }: { open?: boolean } = {},
) {
  const host = productHost({
    agents,
    projects,
    machines: [machineView({ id: "m1", name: "这台", home: "/Users/me" })],
    conversations,
  });
  host.target(
    "providers",
    {
      config: {
        revision: "r1",
        providers: [
          {
            id: "p",
            name: "P",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:1/v1",
            hasApiKey: true,
            models: [{ id: "m1", name: "Qwen 3.8", contextWindow: 32_000 }],
          },
        ],
      },
    },
    { eager: true },
  );
  const mounted = await mount(
    <SidebarProvider defaultOpen={open}>
      <ConversationList />
    </SidebarProvider>,
  );
  await flush();
  return { ...mounted, host };
}

const groupsSection = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-labelledby="sidebar-groups"]');
const agentsSection = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-labelledby="sidebar-agents"]');
const cards = (container: HTMLElement) =>
  [
    ...(groupsSection(container)?.querySelectorAll(
      "[data-slot=conversation-path]",
    ) ?? []),
  ].map((node) => ({
    text: node.textContent,
    title: node.getAttribute("title"),
  }));
const conversationIds = (container: HTMLElement) =>
  [
    ...(groupsSection(container)?.querySelectorAll(
      "[data-slot=conversation-id]",
    ) ?? []),
  ].map((node) => ({
    text: node.textContent,
    title: node.getAttribute("title"),
  }));
const groupRows = (container: HTMLElement) =>
  [
    ...(groupsSection(container)?.querySelectorAll(
      '[data-sidebar="menu-button"]',
    ) ?? []),
  ].map((row) => row.getAttribute("title"));
const agentRows = (container: HTMLElement) => [
  ...(agentsSection(container)?.querySelectorAll(
    '[data-sidebar="menu-button"]',
  ) ?? []),
];
const agentNames = (container: HTMLElement) =>
  agentRows(container).map(
    (row) => row.querySelector("[data-slot=agent-name]")?.textContent,
  );

describe("hello 之前的侧边栏", () => {
  it("draws both lists' outlines instead of saying they are empty", async () => {
    buildProductHost({ agents, projects, conversations: [] }).install();
    const { container } = await mount(
      <SidebarProvider>
        <ConversationList />
      </SidebarProvider>,
    );
    await flush();
    expect(
      groupsSection(container)?.querySelector('[role="status"]'),
    ).not.toBeNull();
    expect(
      agentsSection(container)?.querySelector('[role="status"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain(
      translate("chat:groups.empty.title"),
    );
    expect(container.textContent).not.toContain(
      translate("chat:sections.noAgents"),
    );
  });

  it("says they are empty once they arrive, with no outline left", async () => {
    productHost({ projects, conversations: [] });
    const { container } = await mount(
      <SidebarProvider>
        <ConversationList />
      </SidebarProvider>,
    );
    await flush();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain(
      translate("chat:groups.empty.title"),
    );
    expect(container.textContent).toContain(
      translate("chat:sections.noAgents"),
    );
  });
});

describe("侧边栏的两块", () => {
  it("卡片上写着会话 id 和缩写路径，悬停给全路径", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    // The directory the group runs in is part of what the group is, so it is on the card.
    expect(cards(container)).toEqual([
      { text: "~/Desktop/eta", title: "/Users/me/Desktop/eta" },
    ]);
    expect(conversationIds(container)[0]?.title).toBe("g1");
  });

  it("同目录的卡片挨在一起", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "装修", "p-house"),
      group("g3", "装配二", "p-eta"),
    ]);
    expect(cards(container).map((card) => card.text)).toEqual([
      "~/Desktop/eta",
      "~/Desktop/eta",
      "/srv/house",
    ]);
  });

  it("同一个目录下的群归在一组，按最近活跃排", async () => {
    const now = Date.now();
    const { container } = await tree([
      group("g1", "旧的", "p-eta", { lastMessageAt: now - 7_200_000 }),
      group("g2", "新的", "p-eta", { lastMessageAt: now - 60_000 }),
      // Older than "新的" from the same `now`, but newer than "旧的".
      group("g3", "别处", "p-house", { lastMessageAt: now - 3_600_000 }),
    ]);
    expect(new Set(cards(container).map((card) => card.text)).size).toBe(2);
    // Within the directory: newest first. Across directories: newest first as well.
    expect(groupRows(container)).toEqual(["新的", "旧的", "别处"]);
  });

  it("选中的那张卡片带着成员，其余只收起成员", async () => {
    useWorkspaceStore.setState({ workspace: { selectedGroupId: "g2" } });
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "装修", "p-eta"),
    ]);
    const members = (id: string) =>
      container.querySelectorAll(
        `[data-sidebar="menu-item"]:has([title="${id}"]) [data-slot=member-row]`,
      );
    expect(members("装修")).toHaveLength(2);
    expect(members("装配")).toHaveLength(0);
  });

  it("三角能把没选中的群也打开", async () => {
    useWorkspaceStore.setState({ workspace: { selectedGroupId: "g2" } });
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "装修", "p-eta"),
    ]);
    const row = container.querySelector(
      '[data-sidebar="menu-item"]:has([title="装配"])',
    )!;
    await click(row.querySelector('[aria-label="展开成员"]'));
    expect(row.querySelectorAll("[data-slot=member-row]")).toHaveLength(2);
  });

  it("忙着的成员不只是一个色块，读屏能听到状态", async () => {
    useWorkspaceStore.setState({ workspace: { selectedGroupId: "g1" } });
    const { container } = await tree([
      group("g1", "装配", "p-eta", {
        participants: [
          memberView("a1", { status: "working" }),
          memberView("a2"),
        ],
      }),
    ]);
    const rows = [...container.querySelectorAll("[data-slot=member-row]")];
    expect(
      rows.map((row) => row.querySelector(".sr-only")?.textContent),
    ).toEqual(["工作中", undefined]);
  });

  it("智能体带 persona 和模型，没配的就不显示那一行", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const [first, second] = agentRows(container);
    // a1 wears INFJ and runs p:m1, which the catalog calls Qwen 3.8.
    expect(first?.querySelector("[data-slot=agent-tags]")?.textContent).toBe(
      "INFJ · Qwen 3.8",
    );
    // a2 has neither, so it is one line: no tags element at all beats two empty ones.
    expect(second?.querySelector("[data-slot=agent-tags]")).toBeNull();
  });

  it("智能体区能折叠，折叠状态记在本地", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const header = agentsSection(container)!.querySelector(
      'button[aria-expanded="true"]',
    )!;
    expect(agentNames(container)).toHaveLength(2);
    await click(header);
    expect(agentNames(container)).toHaveLength(0);
    expect(useWorkspaceStore.getState().workspace.agentsCollapsed).toBe(true);
  });

  it("已归档的既不在群聊里，也不把智能体带回来", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "旧的", "p-eta", { archived: true }),
      direct("d1", "a2", { archived: true }),
    ]);
    expect(groupRows(container)).toEqual(["装配"]);
    // a1 has no chat at all, a2's chat is archived: only a1 is offered.
    expect(agentNames(container)).toEqual(["乐子人"]);
  });

  it("点群的行就打开它", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    await click(
      groupsSection(container)!.querySelector('[data-sidebar="menu-button"]'),
    );
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g1" },
    });
  });

  it("群聊组头的 + 是新建对话", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const adds = groupsSection(container)!.querySelectorAll(
      'button[title="新对话"]',
    );
    expect(adds).toHaveLength(1);
    await click(adds[0]);
    expect(useWorkspaceStore.getState().newConversation).toEqual({
      open: true,
    });
  });

  it("智能体组头的动作是新建智能体", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const add = agentsSection(container)!.querySelector(
      'button[title="新建智能体"]',
    )!;
    await click(add);
    expect(useWorkspaceStore.getState().agentEditor).toEqual({
      open: true,
      agentId: null,
    });
  });
});

describe("折叠成图标栏", () => {
  it("群卡片是成员头像上面、小字名称下面，点它还是打开那个群", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")], {
      open: false,
    });
    const section = groupsSection(container)!;
    const card = section.querySelector<HTMLElement>(
      '[data-sidebar="menu-button"]',
    )!;
    const name = card.querySelector("[data-slot=conversation-name]")!;
    // The rail keeps two things off the wide card: who is in the group, and its name.
    expect(name.textContent).toBe("装配");
    expect(name.className).toContain("text-[10px]");
    expect(name.className).toContain("truncate");
    expect(card.querySelectorAll("img").length).toBeGreaterThan(0);
    // 成员行和 ⋯ 菜单在 rail 上没有地方，也就不在了：卡片就是一个按钮。
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(section.querySelectorAll("[data-slot=member-row]")).toHaveLength(0);
    // 「●」只是颜字，不该读进按钮名里。
    expect(card.textContent).not.toContain("●");
    await click(card);
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g1" },
    });
  });

  it("智能体卡片也是头像加小字名称，点它还是进那个智能体", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")], {
      open: false,
    });
    const section = agentsSection(container)!;
    const names = [
      ...section.querySelectorAll("[data-slot=agent-name]"),
    ] as HTMLElement[];
    expect(names.map((node) => node.textContent)).toEqual([
      "乐子人",
      "装配检查",
    ]);
    expect(names[0]?.className).toContain("text-[10px]");
    // 没读的用角标，读过的是状态点：两种都不会在 rail 上静默消失。
    const corner = (id: string) =>
      [...section.querySelectorAll("[data-sidebar=menu-item]")].find(
        (item) =>
          item.querySelector(`[data-slot=agent-name]`)?.textContent === id,
      )!;
    expect(
      corner("乐子人").querySelector("[data-slot=agent-unread]"),
    ).toBeNull();
    expect(
      [...corner("乐子人").children].filter(
        (child) => child.tagName !== "BUTTON",
      ),
    ).toHaveLength(1);
  });

  it("有未读时 rail 卡片角上是数字", async () => {
    const { container } = await tree([direct("d1", "a1", { unread: 3 })], {
      open: false,
    });
    expect(
      agentsSection(container)!.querySelector("[data-slot=agent-unread]")
        ?.textContent,
    ).toBe("3");
    // 数字画在卡角（按钮外），所以按钮名里也得写一份，不让它只活在视觉上。
    expect(
      agentsSection(container)!.querySelector("[data-sidebar=menu-button]")
        ?.textContent,
    ).toContain("3");
  });

  it("折叠成 rail 时组头不写字，新建的 + 还在", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")], {
      open: false,
    });
    expect(
      groupsSection(container)!.querySelector("#sidebar-groups"),
    ).not.toBeNull();
    // 分区名还在，只是不画出来。
    expect(
      groupsSection(container)!.querySelector<HTMLElement>("#sidebar-groups")
        ?.className,
    ).toContain("sr-only");
    await click(
      groupsSection(container)!.querySelector('button[title="新对话"]'),
    );
    expect(useWorkspaceStore.getState().newConversation).toEqual({
      open: true,
    });
  });
});
