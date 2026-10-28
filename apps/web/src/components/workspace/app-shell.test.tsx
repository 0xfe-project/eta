import type {
  BoardTaskDetail,
  ConversationSummary,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  productHost,
  projectView,
  taskDetail,
} from "@/test-product";
import { agentStatusLabels } from "./agent-status";
import { Sidebar } from "./app-shell";
import { GroupList } from "./groups";
import { useWorkspaceStore } from "./workspace-store";

const state = rstest.hoisted(() => ({
  agents: [] as { id: string; name: string; status: string }[],
  groups: [] as ConversationSummary[],
  openAgent: rstest.fn(),
  pathname: "/",
}));
/** The board, for the count the rail has to keep. */
let tasks: BoardTaskDetail[] = [];
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: state.agents,
    loaded: true,
    error: undefined,
    openEditor: () => undefined,
    select: () => undefined,
    current: undefined,
    retry: () => undefined,
  }),
  useOpenAgent: () => state.openAgent,
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: state.groups, current: undefined }),
  useOpenGroup: () => () => undefined,
}));
// The sidebar links through the router; this test is about the list, so the link is a plain one.
rstest.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: React.ReactNode;
    to?: string;
  }) => (
    <a data-to={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
  useNavigate: () => () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
/**
 * The sidebar, in a provider of its own. `open` is the provider's default: what a first visit
 * starts with. Without it the provider reads the cookie, which is how a reload is replayed.
 */
async function render(
  node: React.ReactNode,
  { open }: { open?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  productHost({
    agents: state.agents.map((a, index) =>
      agentView({ ...a, createdAt: index + 1 } as Parameters<
        typeof agentView
      >[0]),
    ),
    projects: [
      projectView({
        id: "p-eta",
        name: "eta",
        path: "/Users/me/Desktop/eta",
      }),
      projectView({
        id: "p-house",
        name: "house",
        path: "/Users/me/work/house",
      }),
      projectView({
        id: "p",
        name: "p",
        path: "/p",
      }),
    ],
    conversations: state.groups,
    tasks: tasks.map((task) => ({ task })),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SidebarProvider defaultOpen={open}>
          <TooltipProvider>{node}</TooltipProvider>
        </SidebarProvider>
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  state.openAgent.mockClear();
  state.pathname = "/";
  tasks = [];
  // What the last toggle left behind belongs to that test, not to the next one.
  document.cookie = "sidebar_state=; path=/; max-age=0";
  setWire(undefined);
});

const agent = (id: string, name: string, status = "idle") => ({
  id,
  name,
  status,
});

describe("左栏的两块", () => {
  const now = Date.now();
  const lists = () => {
    state.agents = [
      agent("a1", "乐子人"),
      agent("a2", "装配检查", "working"),
      agent("a3", "闲着"),
    ];
    // `useGroups` hands the conversations over newest activity first.
    state.groups = [
      conversationView({
        id: "d1",
        name: "乐子人",
        kind: "direct",
        projectId: "p",
        participants: [memberView("a1")],
        lastMessageAt: now - 60_000,
      }),
      conversationView({
        id: "g1",
        name: "装配",
        projectId: "p",
        participants: [memberView("a1"), memberView("a2")],
        lastMessageAt: now - 3_600_000,
      }),
    ];
  };

  it("holds the groups above and the agents below", async () => {
    lists();
    const container = await render(<Sidebar />);
    const section = (id: string) =>
      container.querySelector(`[aria-labelledby="${id}"]`)!;
    // Groups: only the one that is not a private chat.
    expect(
      [
        ...section("sidebar-groups").querySelectorAll(
          '[data-sidebar="menu-button"]',
        ),
      ].map((row) => row.getAttribute("title")),
    ).toEqual(["装配"]);
    // Agents: every agent once. 乐子人 has a chat so it sorts by it; the two without one follow
    // in the order they were made.
    const names = [
      ...section("sidebar-agents").querySelectorAll("[data-slot=agent-name]"),
    ].map((node) => node.textContent);
    expect(names).toEqual(["乐子人", "装配检查", "闲着"]);
    expect(container.textContent).toContain("群聊");
    expect(container.textContent).toContain("智能体");
  });

  it("shows an agent without a chat with its status", async () => {
    lists();
    const container = await render(<Sidebar />);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("装配检查"),
    )!;
    expect(row.textContent).toBe(`装配检查${agentStatusLabels.working}`);
  });

  it("opens the direct chat of an agent without one when it is pressed", async () => {
    lists();
    const container = await render(<Sidebar />);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("装配检查"),
    )!;
    await act(async () => row.click());
    expect(state.openAgent).toHaveBeenCalledWith("a2");
  });

  it("creates an agent from the agent section's own +", async () => {
    lists();
    const container = await render(<Sidebar />);
    const add = container.querySelector<HTMLButtonElement>(
      'button[title="新建智能体"]',
    )!;
    await act(async () => add.click());
    expect(useWorkspaceStore.getState().agentEditor).toEqual({
      open: true,
      agentId: null,
    });
  });

  it("is the same single list on the phone's home", async () => {
    lists();
    const container = await render(<GroupList />);
    const titles = [...container.querySelectorAll("li button")].map((b) =>
      b.getAttribute("title"),
    );
    expect(titles).toEqual([
      "乐子人",
      "装配",
      "与 装配检查 对话",
      "与 闲着 对话",
    ]);
    // One title, and it is the screen's: the list carries no heading of its own, so a phone does
    // not spend its first hundred pixels saying 「对话列表」 twice.
    expect(container.querySelectorAll("h2")).toHaveLength(0);
    const row = [...container.querySelectorAll<HTMLElement>("li button")].find(
      (b) => b.textContent?.includes("闲着"),
    )!;
    await act(async () => row.click());
    expect(state.openAgent).toHaveBeenCalledWith("a3");
  });

  it("says so once when there is nothing to chat with", async () => {
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    expect(container.textContent).toContain("还没有对话");
  });
});

describe("左栏的页眉", () => {
  it("carries the wordmark and the fold", async () => {
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    const header = container.querySelector('[data-sidebar="header"]')!;
    // BR1's wordmark: the letters, uppercase and tracked out, not a wordmark image.
    expect(header.textContent).toContain("ETA");
    // BR1's wordmark: the letters, uppercase and tracked out, not a wordmark image. 设置 is not
    // here any more — it is its own group at the foot of the rail — so the band holds the wordmark
    // and the fold and nothing else.
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(
      header
        .querySelector('[data-slot="sidebar-trigger"]')
        ?.getAttribute("aria-label"),
    ).toBe("折叠或展开侧栏");
    expect(container.querySelectorAll('button[title="设置"]')).toHaveLength(1);
  });

  it("links the sections and marks the current one", async () => {
    state.pathname = "/tasks";
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    const links = [...container.querySelectorAll("a[data-to]")].filter((a) =>
      a.hasAttribute("data-active"),
    );
    // Only the page that remains; 定时 is off in this build, and chat, pending
    // and memory have no button.
    expect(links.map((a) => a.getAttribute("data-to"))).toEqual([
      "/tasks",
      "/email",
    ]);
    expect(links.map((a) => a.textContent)).toEqual(["任务", "邮箱"]);
    expect(
      links
        .filter((a) => a.getAttribute("data-active") === "true")
        .map((a) => a.getAttribute("data-to")),
    ).toEqual(["/tasks"]);
  });
});

describe("折叠成图标栏", () => {
  const lists = () => {
    state.agents = [agent("a1", "乐子人"), agent("a2", "装配检查", "working")];
    state.groups = [
      conversationView({
        id: "g1",
        name: "装配",
        projectId: "p",
        participants: [memberView("a1")],
        lastMessageAt: Date.now() - 60_000,
      }),
    ];
  };
  const root = (container: HTMLElement) =>
    container.querySelector('[data-slot="sidebar"]')!;
  const press = async (node: Element) =>
    act(async () =>
      node.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

  it("只剩图标，靠 aria-label 说去哪", async () => {
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />, { open: false });
    expect(root(container).getAttribute("data-state")).toBe("collapsed");
    expect(root(container).getAttribute("data-collapsible")).toBe("icon");
    const links = [...container.querySelectorAll("a[data-to][aria-label]")];
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "任务",
      "邮箱",
    ]);
    // No text in the rail: the name a link lost is the name it has to carry for the reader.
    expect(links.map((a) => a.textContent)).toEqual(["", ""]);
    expect(links[0]?.querySelector("svg")).not.toBeNull();
  });

  it("待验收的数量在图标上是角标", async () => {
    tasks = [
      taskDetail({ id: "t1", number: 1, status: "in_review" }),
      taskDetail({ id: "t2", number: 2, status: "in_review" }),
      taskDetail({ id: "t3", number: 3, status: "todo" }),
    ];
    const container = await render(<Sidebar />, { open: false });
    expect(
      container.querySelector('[data-slot="menu-badge-dot"]')?.textContent,
    ).toBe("2");
    // The number is also in the link's name: the rail hides the badge, and a count a reader
    // cannot hear is a count the fold took away.
    expect(
      container
        .querySelector('a[data-to="/tasks"]')
        ?.getAttribute("aria-label"),
    ).toBe("任务 · 2");
  });

  it("设置单独成组，排在侧栏最下方", async () => {
    // 分区列表里只剩能在页面间移动的去处；设置是离开它们的门，所以单独一组、贴在最下面。
    const rows = (container: HTMLElement) => {
      const nav = container.querySelector('ul[aria-label="分区"]')!;
      return [...nav.querySelectorAll("li")].map((item) => {
        const control = item.querySelector("button, a")!;
        return control.getAttribute("aria-label") ?? control.textContent;
      });
    };
    const open = await render(<Sidebar />, { open: true });
    expect(rows(open)).toEqual(["任务", "邮箱"]);
    const rail = await render(<Sidebar />, { open: false });
    expect(rows(rail)).toEqual(["折叠或展开侧栏", "任务", "邮箱"]);

    // 它自己那一组：页脚里一条，不在分区列表里。
    for (const [container, isRail] of [
      [open, false],
      [rail, true],
    ] as const) {
      const footer = container.querySelector('[data-slot="sidebar-footer"]')!;
      expect(footer).not.toBeNull();
      const row = footer.querySelector('button[title="设置"]')!;
      expect(row).not.toBeNull();
      expect(
        container.querySelector('ul[aria-label="分区"]')?.contains(row),
      ).toBe(false);
      // 和任务同一行：同一个字号，而不是图标按钮里塞一段更大的字。
      expect(row.getAttribute("data-sidebar")).toBe("menu-button");
      expect(row.className).toContain("text-sm");
      if (isRail) {
        // 图标栏里居中靠的是 auto margin，而按钮自带 `flex`（不是 `inline-flex`，inline 盒不吃
        // auto margin）——少了那一半，齿轮会贴左。
        expect(row.className).toContain("mx-auto");
        expect(row.className).not.toContain("inline-flex");
      }
    }

    // The rail's band is the wordmark alone: no control shares those 40px with it, and the shell
    // hides even that group (a 4rem rail is narrower than the lights' corridor).
    const header = rail.querySelector('[data-sidebar="header"]')!;
    expect(header.querySelectorAll("button")).toHaveLength(0);
  });

  it("开关能折叠也能展开，刷新后还记着", async () => {
    const container = await render(<Sidebar />);
    expect(root(container).getAttribute("data-state")).toBe("expanded");
    await press(container.querySelector('[data-slot="sidebar-trigger"]')!);
    expect(root(container).getAttribute("data-state")).toBe("collapsed");
    expect(document.cookie).toContain("sidebar_state=false");
    // A reload starts from the cookie, not from the provider's default.
    const again = await render(<Sidebar />);
    expect(root(again).getAttribute("data-state")).toBe("collapsed");
    expect(
      again.querySelector('a[data-to="/tasks"]')?.getAttribute("aria-label"),
    ).toBe("任务");
    // And back: the same button unfolds it.
    await press(again.querySelector('[data-slot="sidebar-trigger"]')!);
    expect(root(again).getAttribute("data-state")).toBe("expanded");
  });

  it("卡片是小字名称，点它还是进那个群或智能体", async () => {
    lists();
    const container = await render(<Sidebar />, { open: false });
    const name = container.querySelector('[data-slot="conversation-name"]')!;
    expect(name.textContent).toBe("装配");
    expect(name.className).toContain("text-[10px]");
    expect(name.className).toContain("truncate");
    const agentName = container.querySelector('[data-slot="agent-name"]')!;
    expect(agentName.textContent).toBe("乐子人");
    expect(agentName.className).toContain("text-[10px]");
    // The whole card is still the target: a rail card is one button, not a heading beside one.
    const agents = container.querySelector(
      '[aria-labelledby="sidebar-agents"]',
    )!;
    await press(agents.querySelector('[data-sidebar="menu-button"]')!);
    expect(state.openAgent).toHaveBeenCalledWith("a1");
  });

  it("页眉先把窗口红绿灯的位置留出来，字标才不会被压在灯下面", async () => {
    const container = await render(<Sidebar />);
    const band = container.querySelector('[data-sidebar="header"]')!;
    const slot = band.querySelector(".lights-slot")!;
    // 槽位在字标之前，而且本身就是空的：红绿灯是窗口画的，这块地方只管把宽度留出来。
    expect(slot.nextElementSibling?.textContent).toBe("ETA");
    expect(slot.querySelectorAll("button, a")).toHaveLength(0);
    expect(band.getAttribute("data-rail")).toBe("false");
    // 折叠时也一样，只是那里由 CSS 把字标让开（4rem 的栏没有灯旁边的位置）。
    const rail = await render(<Sidebar />, { open: false });
    expect(
      rail.querySelector('[data-sidebar="header"]')?.getAttribute("data-rail"),
    ).toBe("true");
    // 浏览器里没有 data-host，槽位不占位：外观和改动前一模一样。
    expect(document.documentElement.hasAttribute("data-host")).toBe(false);
  });
});
