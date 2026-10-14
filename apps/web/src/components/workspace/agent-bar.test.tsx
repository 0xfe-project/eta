import type { Group } from "@/queries/chat";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentBar, AgentTitle } from "./agent-bar";

const opened: string[] = [];
const direct = (id: string, agent: string, name: string) =>
  ({
    id,
    name,
    kind: "direct",
    archived: false,
    participants: [{ agent_id: agent, name, member: true }],
  }) as unknown as Group;
const groups = [
  direct("d1", "a1", "小明"),
  direct("d2", "a2", "一个名字非常非常非常长的智能体助手"),
  {
    id: "g1",
    name: "发布讨论",
    kind: "group",
    archived: false,
    participants: [
      { agent_id: "a1", name: "小明", member: true },
      { agent_id: "a2", name: "长名字", member: true },
    ],
  } as unknown as Group,
];
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups }),
  useOpenGroup: () => (id: string) => opened.push(id),
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [
      { id: "a1", name: "小明", status: "idle" },
      {
        id: "a2",
        name: "一个名字非常非常非常长的智能体助手",
        status: "working",
      },
    ],
    openEditor: () => {},
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}
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
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
});

describe("顶部名称切换智能体", () => {
  it("lists the agents, marks the current one and opens the other's direct chat", async () => {
    const container = await render(
      <AgentBar group={groups[0]} onInfo={() => {}} />,
    );
    const trigger = await openMenu(container);
    expect(trigger.getAttribute("aria-label")).toBe(
      "正在与 小明 私聊（空闲），切换智能体",
    );
    const [first, second] = items();
    expect(first.textContent).toContain("小明");
    expect(first.querySelector('[aria-label="当前"]')).not.toBeNull();
    expect(second.querySelector('[aria-label="当前"]')).toBeNull();
    await act(async () => second.click());
    expect(opened).toEqual(["d2"]);
  });

  it("shows the group as current and only navigates from it", async () => {
    const container = await render(
      <AgentTitle group={groups[2]} onInfo={() => {}} />,
    );
    await openMenu(container);
    const [current, ...rest] = items();
    expect(current.textContent).toContain("群 · 发布讨论");
    expect(current.querySelector('[aria-label="当前"]')).not.toBeNull();
    expect(rest.some((i) => i.querySelector('[aria-label="当前"]'))).toBe(
      false,
    );
    await act(async () => rest[0].click());
    expect(opened).toEqual(["d1"]);
  });
});
