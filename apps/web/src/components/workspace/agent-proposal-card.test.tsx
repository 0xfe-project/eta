import type {
  CaptainAgentProposal,
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
import { buildProductHost, machineView, messageView } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { GroupNotice } from "./group-notice";

// An agent Captain proposed, drawn as a card: what it would be and what it would wear, the two
// answers while it waits, and how it ended, read from the same operation the Captain panel lists.

const proposal: CaptainAgentProposal = {
  originConversationId: "c1",
  messageId: "row1",
  name: "Scout",
  purpose: "盯着仓库，说清改了什么。",
  instructions: "每天早晨看一遍仓库，把变化写下来。",
  persona: "Executor",
  model: "openai:gpt-5",
  runtime: "eta",
  plugins: ["github"],
};

const operation = (
  fields: Partial<CaptainOperationView>,
): CaptainOperationView => ({
  id: "op1",
  kind: "create_agent",
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

const proposed = (fields: Partial<CaptainAgentProposal> = {}) =>
  row({
    event: "captain_proposal",
    kind: "create_agent",
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
    machines: [
      machineView({ id: "m1", kind: "primary", name: "这台机器" }),
      machineView({ id: "m2", kind: "daemon", name: "另一台" }),
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

describe("an agent Captain proposes", () => {
  it("says what it would be, and waits for create or reject", async () => {
    const { container, host } = await show(proposed(), [operation({})]);
    for (const shown of [
      "新智能体",
      "Scout",
      "盯着仓库，说清改了什么。",
      "Executor",
      "openai:gpt-5",
      "eta",
      "github",
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

  it("leaves out the plugins line when there are none", async () => {
    const { container } = await show(proposed({ plugins: [] }), [
      operation({}),
    ]);
    expect(container.textContent).not.toContain("插件");
    expect(container.textContent).toContain("Scout");
  });

  it("says it is ready once it was made, and offers nothing to press", async () => {
    const { container } = await show(proposed(), [
      operation({
        status: "applied",
        result: { agentId: "a-new", projectId: "p-new", name: "Scout" },
      }),
    ]);
    expect(container.textContent).toContain("已创建");
    expect(container.textContent).toContain("已就绪");
    expect(button(container, "创建")).toBeUndefined();
    expect(
      container.querySelector("[data-tone]")?.getAttribute("data-tone"),
    ).toBe("success");
  });

  it("says why it failed", async () => {
    const { container } = await show(proposed(), [
      operation({
        status: "failed",
        error: 'an agent named "Scout" already exists',
      }),
    ]);
    expect(container.textContent).toContain("失败");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "already exists",
    );
    expect(button(container, "创建")).toBeUndefined();
    expect(
      container.querySelector("[data-tone]")?.getAttribute("data-tone"),
    ).toBe("error");
  });

  it("offers nothing to press once its operation is no longer listed", async () => {
    const { container } = await show(proposed());
    expect(container.textContent).toContain("Scout");
    expect(container.querySelector("button")).toBeNull();
  });
});
