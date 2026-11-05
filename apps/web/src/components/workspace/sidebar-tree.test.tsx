import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
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
  // On another machine: the same path as p-eta, and one under that machine's own home.
  projectView({
    id: "p-eta-gpu",
    machineId: "m2",
    name: "eta",
    path: "/Users/me/Desktop/eta",
  }),
  projectView({
    id: "p-train",
    machineId: "m2",
    name: "training",
    path: "/home/eric/training",
  }),
];
const machines = [
  machineView({ id: "m1", name: "这台", home: "/Users/me" }),
  machineView({
    id: "m2",
    kind: "daemon",
    name: "gpu-box",
    home: "/home/eric",
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
    machines,
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

// A card's own box: a `border` or a resting `bg-` utility on the card itself. The cards are flat
// rows; the list draws one rule between two, and only hover and selection fill a row.
const box = /(^|\s)(border|bg-)/;

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
  it("卡片上写着缩写路径，悬停给全路径，不写会话 id", async () => {
    const { container } = await tree([group("group-id", "装配", "p-eta")]);
    // The directory the group runs in is part of what the group is, so it is on the card.
    expect(cards(container)).toEqual([
      { text: "~/Desktop/eta", title: "/Users/me/Desktop/eta" },
    ]);
    expect(groupsSection(container)?.textContent).not.toContain("group-id");
  });

  it("别的机器上的目录带着机器名，按那台机器的 home 缩写", async () => {
    const now = Date.now();
    const { container } = await tree([
      group("g1", "eta", "p-eta", { lastMessageAt: now - 60_000 }),
      group("g2", "eta", "p-eta-gpu", { lastMessageAt: now - 120_000 }),
      group("g3", "训练", "p-train", { lastMessageAt: now - 180_000 }),
    ]);
    // One path on two machines is two places, and the cards say which is which.
    expect(cards(container)).toEqual([
      { text: "~/Desktop/eta", title: "/Users/me/Desktop/eta" },
      {
        text: "gpu-box:/Users/me/Desktop/eta",
        title: "gpu-box:/Users/me/Desktop/eta",
      },
      { text: "gpu-box:~/training", title: "gpu-box:/home/eric/training" },
    ]);
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

  it("卡片是平铺的行：不套框、不铺底，行间一条线，线贴到侧栏两边", async () => {
    useWorkspaceStore.setState({ workspace: { selectedGroupId: "g2" } });
    const { container } = await tree([
      group("g1", "装配", "p-eta"),
      group("g2", "装修", "p-eta"),
    ]);
    const item = (id: string) =>
      container.querySelector<HTMLElement>(
        `[data-sidebar="menu-item"]:has([title="${id}"])`,
      )!;
    expect(item("装配").className).not.toMatch(box);
    expect(item("装配").className).toContain("hover:bg-sidebar-accent");
    // 选中的只多一层底色。
    expect(item("装修").className).toContain("bg-sidebar-accent");
    const agents = [
      ...agentsSection(container)!.querySelectorAll<HTMLElement>(
        "[data-sidebar=menu-item]",
      ),
    ];
    expect(agents.length).toBeGreaterThan(0);
    for (const card of agents) expect(card.className).not.toMatch(box);
    for (const section of [
      groupsSection(container)!,
      agentsSection(container)!,
    ]) {
      // 行间的线由列表画，分区不留左右 padding，线和组头下面那条一样贴到两边。
      expect(section.querySelector("[data-sidebar=menu]")?.className).toContain(
        "divide-y",
      );
      expect(section.className).toContain("px-0");
    }
  });

  it("点击区铺满卡片", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const target = container.querySelector<HTMLElement>('[title="装配"]')!;
    expect(target.className).toContain("inset-0");
    const card = target.parentElement!;
    expect(card.querySelector("[data-slot=conversation-path]")).not.toBeNull();
  });

  it("有成员在忙时不只是一个绿点，读屏能听到状态", async () => {
    const { container } = await tree([
      group("g1", "装配", "p-eta", {
        participants: [
          memberView("a1", { status: "working" }),
          memberView("a2"),
        ],
      }),
    ]);
    const target = container.querySelector('[title="装配"]')!;
    expect(target.querySelector(".sr-only")?.textContent).toContain("工作中");
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

  it("组头的两个 + 只有图标，不带边框，点击区域不变", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    for (const add of [
      groupsSection(container)!.querySelector('button[title="新对话"]')!,
      agentsSection(container)!.querySelector('button[title="新建智能体"]')!,
    ]) {
      expect(add.className).not.toContain("border");
      expect(add.className).toContain("size-6");
    }
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
    // 卡片就是一个按钮，菜单挂在它的右键上。
    expect(card.querySelectorAll("button")).toHaveLength(0);
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

  it("rail 上的卡片也是平铺的行，没有框也没有底色", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")], {
      open: false,
    });
    const cards = [
      ...groupsSection(container)!.querySelectorAll<HTMLElement>(
        "[data-sidebar=menu-item]",
      ),
      ...agentsSection(container)!.querySelectorAll<HTMLElement>(
        "[data-sidebar=menu-item]",
      ),
    ];
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      // Only the open group is filled, and only with the selected fill.
      if (card.dataset.active === "true")
        expect(card.className).toContain("bg-sidebar-accent");
      else expect(card.className).not.toMatch(box);
    }
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

describe("卡片的右键菜单", () => {
  const card = (container: HTMLElement) =>
    groupsSection(container)!.querySelector<HTMLElement>(
      '[data-sidebar="menu-button"]',
    )!;
  const rightClick = async (element: Element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => element.dispatchEvent(event));
    return event;
  };
  const menuItems = () => [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  const item = (name: string) =>
    menuItems().find((node) => node.textContent === name);
  const field = (container: HTMLElement) =>
    groupsSection(container)!.querySelector<HTMLInputElement>("input");
  const press = async (input: HTMLInputElement, key: string) => {
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  };
  const type = async (input: HTMLInputElement, text: string) => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const updates = (host: { calls: { action: string; args: unknown }[] }) =>
    host.calls.filter((call) => call.action === "update");

  it("卡片上没有 ⋯，那一行也不再给它留位置", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    const section = groupsSection(container)!;
    expect(section.querySelector("[data-sidebar=menu-action]")).toBeNull();
    expect(section.querySelector(".pr-6")).toBeNull();
  });

  for (const open of [true, false]) {
    const shape = open ? "展开" : "图标栏";

    it(`${shape}：右键打开菜单，不进群，也不留给浏览器`, async () => {
      const { container } = await tree([group("g1", "装配", "p-eta")], {
        open,
      });
      const event = await rightClick(card(container));
      expect(event.defaultPrevented).toBe(true);
      expect(menuItems().map((node) => node.textContent)).toEqual([
        "改名",
        "归档",
      ]);
      expect(navigation.navigate).not.toHaveBeenCalled();
    });

    it(`${shape}：改名变成输入框并拿到焦点，回车提交`, async () => {
      const { container, host } = await tree([group("g1", "装配", "p-eta")], {
        open,
      });
      host.handle("conversations.update", () => ({}));
      await rightClick(card(container));
      await click(item("改名"));
      await flush();
      const input = field(container)!;
      expect(input.value).toBe("装配");
      expect(document.activeElement).toBe(input);
      // 输入框不在触发器里：右键是它自己的浏览器菜单。
      expect((await rightClick(input)).defaultPrevented).toBe(false);
      expect(menuItems()).toHaveLength(0);
      await type(input, "总装");
      await press(input, "Enter");
      await flush();
      expect(updates(host).map((call) => call.args)).toEqual([
        { conversationId: "g1", name: "总装" },
      ]);
      expect(field(container)).toBeNull();
      expect(card(container)).not.toBeNull();
    });

    it(`${shape}：Esc 取消改名，什么也不发`, async () => {
      const { container, host } = await tree([group("g1", "装配", "p-eta")], {
        open,
      });
      await rightClick(card(container));
      await click(item("改名"));
      await flush();
      await type(field(container)!, "总装");
      await press(field(container)!, "Escape");
      await flush();
      expect(field(container)).toBeNull();
      expect(updates(host)).toHaveLength(0);
    });

    it(`${shape}：归档`, async () => {
      const { container, host } = await tree([group("g1", "装配", "p-eta")], {
        open,
      });
      host.handle("conversations.update", () => ({}));
      await rightClick(card(container));
      await click(item("归档"));
      await flush();
      expect(updates(host).map((call) => call.args)).toEqual([
        { conversationId: "g1", archived: true },
      ]);
    });
  }

  // Safari 点按钮不给它焦点，长按也一样：菜单关上时焦点要还给原来的地方，不能抢走改名框。
  it("焦点原本在别处时，改名框也留得住", async () => {
    const { container, host } = await tree([group("g1", "装配", "p-eta")]);
    const elsewhere = document.body.appendChild(
      document.createElement("textarea"),
    );
    elsewhere.focus();
    await rightClick(card(container));
    await click(item("改名"));
    await flush();
    const input = field(container);
    elsewhere.remove();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(updates(host)).toHaveLength(0);
  });

  it("左键还是进群", async () => {
    const { container } = await tree([group("g1", "装配", "p-eta")]);
    await click(card(container));
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g1" },
    });
    expect(menuItems()).toHaveLength(0);
  });
});
