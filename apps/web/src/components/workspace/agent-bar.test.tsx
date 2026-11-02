import type { ConversationSummary } from "@eta/client-contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationSections,
  conversationView,
  machineView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { ChatHeader, MobileChatHeader } from "./agent-bar";

const opened: string[] = [];
const direct = (id: string, agent: string, name: string) =>
  conversationView({
    id,
    name,
    kind: "direct",
    participants: [memberView(agent)],
  });
const groups: ConversationSummary[] = [
  direct("d1", "a1", "小明"),
  direct("d2", "a2", "一个名字非常非常非常长的智能体助手"),
  conversationView({
    id: "g1",
    name: "发布讨论",
    stewardId: "a1",
    participants: [memberView("a1"), memberView("a2")],
  }),
];
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups }),
  useOpenGroup: () => (id: string) => opened.push(id),
}));
const openAgentCalls: string[] = [];
const roster = rstest.hoisted(() => [
  { id: "a1", name: "小明", status: "idle" },
  { id: "a2", name: "一个名字非常非常非常长的智能体助手", status: "working" },
]);
rstest.mock("./use-agents", () => ({
  // The header's avatars open an agent's own conversation; the switch menu reuses the router.
  useOpenAgent: () => (id: string) => openAgentCalls.push(id),
  useAgents: () => ({ agents: roster, openEditor: () => {} }),
}));

let host: ReturnType<typeof productHost>;
beforeEach(() => {
  host = productHost({
    agents: roster.map((agent) =>
      agentView({ ...agent, status: agent.status as "idle" | "working" }),
    ),
    projects: [
      projectView({
        id: "p1",
        name: "eta",
        path: "/Users/me/Desktop/eta",
        stewardId: "a2",
      }),
    ],
    conversations: groups,
  });
  host.handle("conversations.setSteward", () => ({}));
  host.handle("projects.setSteward", () => ({}));
});

async function openMenu(container: HTMLElement) {
  const trigger = container.querySelector("button")!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  return trigger;
}
const items = () => [
  ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];

afterEach(async () => {
  opened.length = 0;
  openAgentCalls.length = 0;
  await cleanup();
  setWire(undefined);
});

describe("手机上的 header", () => {
  it("is three controls: back, the name, and the way to what it is", async () => {
    const { container } = await mount(
      <MobileChatHeader
        name="发布讨论"
        onBack={() => {}}
        backLabel="返回对话列表"
        onInfo={() => {}}
        infoLabel="群信息"
      />,
    );
    const controls = [...container.querySelectorAll("button")];
    expect(controls).toHaveLength(2);
    expect(container.querySelector("h1")!.textContent).toBe("发布讨论");
    // No avatar row and no project chip: those belong to the panel and the chat.
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("header 里的名称切换", () => {
  it("keeps the name, the project, the steward and the members in one row", async () => {
    const project = projectView({
      id: "p1",
      name: "eta",
      path: "/Users/me/Desktop/eta",
    });
    const { container } = await mount(
      <ChatHeader
        group={groups[2]}
        info={conversationSections(groups[2]!).info}
        project={project}
        onInfo={() => {}}
      />,
    );
    await flush();
    expect(container.querySelector("header")).not.toBeNull();
    expect(container.textContent).toContain("发布讨论");
    // The project is the second thing the header answers, and it is in the same row.
    expect(container.textContent).toContain("eta");
    expect(
      container.querySelector('[title="/Users/me/Desktop/eta"]'),
    ).not.toBeNull();
    // The steward is the third.
    expect(
      container.querySelector('[aria-label="主理人：小明"]'),
    ).not.toBeNull();
    // No info or settings buttons of its own: both are reached elsewhere (the switcher's menu,
    // the app's own settings), and a pair of icons after the names read as controls for the group.
    const controls = [...container.querySelectorAll("header button")];
    expect(
      controls.some((button) => button.getAttribute("title") === "设置"),
    ).toBe(false);
    expect(
      controls.some((button) => button.getAttribute("aria-label") === "群信息"),
    ).toBe(false);
    // Members are navigation: pressing one opens that agent alone.
    const avatars = [...container.querySelectorAll("button")].filter((b) =>
      b.getAttribute("title")?.includes("单独"),
    );
    expect(avatars).toHaveLength(2);
    await click(avatars[0]);
    expect(openAgentCalls).toEqual(["a1"]);
  });

  it("names the project's machine in the chip's whole path when it is not the primary", async () => {
    productHost({
      machines: [
        machineView({ id: "m1" }),
        machineView({ id: "m2", kind: "daemon", name: "gpu-box" }),
      ],
    });
    const project = projectView({
      id: "p2",
      machineId: "m2",
      name: "eta",
      path: "/Users/me/Desktop/eta",
    });
    const { container } = await mount(
      <ChatHeader
        group={groups[2]}
        info={conversationSections(groups[2]!).info}
        project={project}
        onInfo={() => {}}
      />,
    );
    await flush();
    // The same name and path as the primary's `eta`: only the machine tells them apart.
    expect(
      container.querySelector('[title="gpu-box:/Users/me/Desktop/eta"]'),
    ).not.toBeNull();
  });

  it("lists the agents, marks the current one and opens the other's direct chat", async () => {
    const { container } = await mount(
      <ChatHeader group={groups[0]} onInfo={() => {}} />,
    );
    await flush();
    const trigger = await openMenu(container);
    expect(trigger.getAttribute("aria-label")).toBe(
      "正在与 小明 私聊（空闲），切换智能体",
    );
    const [first, second] = items();
    expect(first.textContent).toContain("小明");
    expect(first.querySelector('[aria-label="当前"]')).not.toBeNull();
    expect(second.querySelector('[aria-label="当前"]')).toBeNull();
    await click(second);
    expect(opened).toEqual(["d2"]);
  });

  it("shows the group as current and only navigates from it", async () => {
    const { container } = await mount(
      <ChatHeader group={groups[2]} onInfo={() => {}} />,
    );
    await flush();
    await openMenu(container);
    const [current, ...rest] = items();
    expect(current.textContent).toContain("群 · 发布讨论");
    expect(current.querySelector('[aria-label="当前"]')).not.toBeNull();
    expect(rest.some((i) => i.querySelector('[aria-label="当前"]'))).toBe(
      false,
    );
    await click(rest[0]);
    expect(opened).toEqual(["d1"]);
  });
});

describe("主理人芯片", () => {
  it("switches the steward of this conversation, or hands it back to the project", async () => {
    const info = {
      ...conversationSections(groups[2]!).info,
      stewardId: "a2",
      stewardOverrideId: "a2",
    };
    const project = projectView({ id: "p1", name: "eta", stewardId: "a1" });
    const { container } = await mount(
      <ChatHeader
        group={groups[2]}
        info={info}
        project={project}
        onInfo={() => {}}
      />,
    );
    await flush();
    const chip = container.querySelector<HTMLElement>(
      '[aria-label^="主理人："]',
    )!;
    await act(async () => {
      chip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const labels = items().map((item) => item.textContent);
    expect(labels[0]).toContain("跟随项目");
    await click(items().find((item) => item.textContent?.includes("小明")));
    await flush();
    expect(
      host.calls.find((call) => call.action === "setSteward")?.args,
    ).toEqual({ conversationId: "g1", agentId: "a1" });

    await act(async () => {
      chip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await click(items().find((item) => item.textContent?.includes("跟随项目")));
    await flush();
    expect(
      host.calls.filter((call) => call.action === "setSteward").at(-1)?.args,
    ).toEqual({ conversationId: "g1", agentId: null });
  });

  it("is not there in a private chat, which has only its agent", async () => {
    const { container } = await mount(
      <ChatHeader
        group={groups[0]}
        info={conversationSections(groups[0]!).info}
        onInfo={() => {}}
      />,
    );
    await flush();
    expect(container.querySelector('[aria-label^="主理人："]')).toBeNull();
  });
});
