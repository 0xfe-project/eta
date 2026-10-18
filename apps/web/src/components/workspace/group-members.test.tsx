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
  memberView,
  productHost,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { GroupMembers } from "./groups";

const summary = rstest.hoisted(() => ({
  current: undefined as unknown,
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: summary.current }),
  useOpenGroup: () => () => undefined,
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [
      { id: "a1", name: "乐子人", status: "idle" },
      { id: "a2", name: "装配检查", status: "idle" },
      { id: "a3", name: "新来的", status: "idle" },
    ],
    openEditor: () => {},
  }),
}));
rstest.mock("@/queries/tasks", () => ({
  useTasks: () => ({ data: { tasks: [] } }),
  useUpdateTask: () => ({ mutate: () => {}, isPending: false }),
}));

let host: ReturnType<typeof productHost>;
beforeEach(() => {
  const group = conversationView({
    id: "members-1",
    name: "装配",
    participants: [
      memberView("a1", { sessionId: "s1", status: "working" }),
      memberView("a2"),
    ],
  });
  summary.current = group;
  host = productHost({
    agents: [
      agentView({ id: "a1", name: "乐子人" }),
      agentView({ id: "a2", name: "装配检查" }),
      agentView({ id: "a3", name: "新来的" }),
    ],
    conversations: [group],
  });
  host.set("conversations", { list: [group] });
  host.target(
    "conversations.members-1",
    conversationSections(group, [], { goal: "上线", decided: "用 Bun" }),
  );
  host.target("sessions.s1", {
    core: { session: "s1", running: true },
    model: { id: "p:m", thinkingLevel: "off" },
    usage: {
      input: 1500,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1700,
    },
    tools: [{ name: "bash", description: "" }],
    goal: { objective: "修好它", status: "active", roundCount: 1 },
    metrics: { tokensPerSec: 12 },
  });
  host.handle("sessions.resync", () => ({}));
  host.handle("sessions.goal", () => ({}));
  host.handle("conversations.invite", () => ({}));
  host.handle("conversations.remove", () => ({}));
  host.handle("conversations.update", () => ({}));
});
afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const dialog = () => document.querySelector('[role="dialog"]')!;
const menu = async (trigger: Element | null | undefined) =>
  act(async () => {
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

describe("成员和群的管理", () => {
  it("shows each member with the numbers of its own session", async () => {
    const { container } = await mount(<GroupMembers />);
    await flush();
    expect(container.textContent).toContain("乐子人");
    expect(container.textContent).toContain("装配检查");
    // usage, tools and goal, from sessions.<id>
    expect(container.textContent).toContain("p:m");
    expect(container.textContent).toContain("1.5k");
    expect(container.textContent).toContain("12 tok/s");
    expect(container.textContent).toContain("tools 1");
    expect(container.textContent).toContain("修好它");
    // The member without a session says so.
    expect(container.textContent).toContain("还没和它说过话");
  });

  it("pauses a member's goal through its session", async () => {
    const { container } = await mount(<GroupMembers />);
    await flush();
    const pause = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "暂停",
    );
    await click(pause);
    await flush();
    expect(host.calls.find((c) => c.action === "goal")?.args).toEqual({
      session: "s1",
      action: "pause",
    });
  });

  it("invites an agent that is not in the group", async () => {
    const { container } = await mount(<GroupMembers />);
    await flush();
    await click(
      [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("邀请"),
      ),
    );
    await click(
      [...dialog().querySelectorAll("button")].find((b) =>
        b.textContent?.includes("新来的"),
      ),
    );
    await flush();
    expect(host.calls.find((c) => c.action === "invite")?.args).toEqual({
      conversationId: "members-1",
      agentId: "a3",
    });
  });

  it("removes a member after asking", async () => {
    const { container } = await mount(<GroupMembers />);
    await flush();
    await menu(container.querySelector('[aria-label="装配检查 的操作"]'));
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((i) =>
        i.textContent?.includes("移除"),
      ),
    );
    await click(
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (b) => b.textContent === "移除",
      ),
    );
    await flush();
    expect(host.calls.find((c) => c.action === "remove")?.args).toEqual({
      conversationId: "members-1",
      agentId: "a2",
    });
  });

  it("edits the name, the goal and what was decided together", async () => {
    const { container } = await mount(<GroupMembers />);
    await flush();
    await menu(container.querySelector('[aria-label="群操作"]'));
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((i) =>
        i.textContent?.includes("编辑群信息"),
      ),
    );
    const fields = dialog().querySelectorAll("textarea");
    // Filled from the conversation's own facts.
    expect((fields[0] as HTMLTextAreaElement).value).toBe("上线");
    expect((fields[1] as HTMLTextAreaElement).value).toBe("用 Bun");
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      set.call(fields[1], "用 Bun 和 SQLite");
      fields[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      dialog()
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await flush();
    expect(host.calls.find((c) => c.action === "update")?.args).toEqual({
      conversationId: "members-1",
      name: "装配",
      goal: "上线",
      decided: "用 Bun 和 SQLite",
    });
  });
});
