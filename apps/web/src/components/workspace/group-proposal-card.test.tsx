import type {
  CaptainGroupProposal,
  CaptainOperationView,
  MessageView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { setWire } from "@/lib/wire";
import { agentView, buildProductHost, messageView } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { GroupNotice } from "./group-notice";

// A group Captain proposed, drawn as a card: what it would be, the two answers while it waits, and
// how it ended, read from the same operation the Captain panel lists.

const proposal: CaptainGroupProposal = {
  originConversationId: "c1",
  messageId: "row1",
  name: "发布",
  goal: "上线发布页",
  memberIds: ["a1", "a2"],
  stewardId: "a2",
  projectId: null,
  machineId: "m1",
  path: "/home/me/small-repo",
  projectName: "small-repo",
};

const operation = (
  fields: Partial<CaptainOperationView>,
): CaptainOperationView => ({
  id: "op1",
  kind: "create_group",
  actorAgentId: "cap",
  requiresApproval: true,
  status: "pending",
  payload: {},
  result: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

const row = (data: Record<string, unknown>): MessageView =>
  messageView({
    id: "row1",
    conversationId: "c1",
    kind: "system",
    author: "system",
    text: "",
    data,
  });

const proposed = (fields: Partial<CaptainGroupProposal> = {}) =>
  row({
    event: "captain_group_proposal",
    operationId: "op1",
    proposal: { ...proposal, ...fields },
  });

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

async function show(
  message: MessageView,
  operations: CaptainOperationView[] = [],
) {
  const host = buildProductHost({
    agents: [
      agentView({ id: "a1", name: "Ada" }),
      agentView({ id: "a2", name: "Bola" }),
    ],
  });
  host.target(
    "captain",
    {
      identity: null,
      assignments: [],
      operations,
      memoryPauses: [],
      settings: {},
    },
    { eager: true },
  );
  host.handle("captain.decideOperation", () => ({
    operation: operation({ status: "applied" }),
  }));
  host.install();
  host.hello();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <GroupNotice message={message} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const { container } = await mount(<RouterProvider router={router} />);
  await flush();
  return { container, host };
}

describe("a group Captain proposes", () => {
  it("says what it would be, and waits for create or reject", async () => {
    const { container, host } = await show(proposed(), [operation({})]);
    for (const shown of [
      "发布",
      "small-repo",
      "新项目",
      "/home/me/small-repo",
      "Ada, Bola",
      "主理人Bola",
      "上线发布页",
      "待确认",
    ])
      expect(container.textContent).toContain(shown);
    await click(button(container, "拒绝"));
    await click(button(container, "创建"));
    await flush();
    expect(
      host.calls
        .filter((call) => call.action === "decideOperation")
        .map((call) => call.args),
    ).toEqual([
      { operationId: "op1", decision: "reject" },
      { operationId: "op1", decision: "approve" },
    ]);
  });

  it("leaves out the badge for an existing project and a goal it has none of", async () => {
    const { container } = await show(
      proposed({ projectId: "p1", goal: null }),
      [operation({})],
    );
    expect(container.textContent).not.toContain("新项目");
    expect(container.textContent).not.toContain("目标");
  });

  it("links to the group it made", async () => {
    const { container } = await show(proposed(), [
      operation({
        status: "applied",
        result: { conversationId: "g-new", projectId: "p1" },
      }),
    ]);
    expect(container.textContent).toContain("已创建");
    expect(button(container, "创建")).toBeUndefined();
    expect(container.querySelector("a")?.getAttribute("href")).toContain(
      "group=g-new",
    );
  });

  it("says why it failed", async () => {
    const { container } = await show(proposed(), [
      operation({
        status: "failed",
        error: "a group named 发布 already exists",
      }),
    ]);
    expect(container.textContent).toContain("失败");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "already exists",
    );
    expect(button(container, "创建")).toBeUndefined();
  });

  it("colours only the outcome: waiting is grey, created is success, failed is error", async () => {
    // Waiting for a person to press Create is not a warning. A state colour is a square beside the
    // word, never a border or a fill on the card.
    for (const [status, tone] of [
      ["pending", "neutral"],
      ["applied", "success"],
      ["rejected", "neutral"],
      ["failed", "error"],
    ] as const) {
      const { container } = await show(proposed(), [operation({ status })]);
      const mark = container.querySelector("[data-tone]");
      expect(mark?.getAttribute("data-tone")).toBe(tone);
      expect(mark?.querySelector('[aria-hidden="true"]')?.className).toContain(
        "size-1.5",
      );
      expect(container.innerHTML).not.toContain("state-warning");
      expect(container.innerHTML).not.toContain("task-fold-waiting");
      await cleanup();
      setWire(undefined);
    }
  });

  it("offers nothing to press once its operation is no longer listed", async () => {
    const { container } = await show(proposed());
    expect(container.textContent).toContain("发布");
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("a group Captain made", () => {
  it("opens with the line that says so", async () => {
    const { container } = await show(row({ event: "captain_created" }));
    expect(container.querySelector(".system-message")?.textContent).toBe(
      "由 Captain 创建",
    );
  });
});
