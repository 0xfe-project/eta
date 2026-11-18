import type {
  CaptainOperationStatus,
  CaptainOperationView,
  MessageView,
} from "@eta/client-contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { agentView, buildProductHost, messageView } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { GroupNotice } from "./group-notice";

// A proposal of Captain's is one folded line in the chat until the reader opens it: what kind, its
// name and where it stands. Opened, it says what it would be and offers the two answers.

const KINDS = {
  create_group: {
    title: "新群",
    label: "提议的群 发布",
    detail: "上线发布页",
    proposal: {
      originConversationId: "c1",
      messageId: "row1",
      name: "发布",
      goal: "上线发布页",
      memberIds: ["a1"],
      stewardId: "a1",
      projectId: null,
      machineId: "m1",
      path: "/home/me/small-repo",
      projectName: "small-repo",
    },
  },
  create_agent: {
    title: "新智能体",
    label: "提议的智能体 Scout",
    detail: "盯着仓库，说清改了什么。",
    proposal: {
      originConversationId: "c1",
      messageId: "row1",
      name: "Scout",
      purpose: "盯着仓库，说清改了什么。",
      instructions: "每天早晨看一遍仓库。",
      persona: "Executor",
      model: "openai:gpt-5",
      runtime: "eta",
      plugins: [],
    },
  },
  create_routine: {
    title: "新建定时任务",
    label: "定时任务提议 Herdr 编辑器 API 每日检查",
    detail: "检查 Herdr 编辑器 API 有没有变。",
    proposal: {
      originConversationId: "c1",
      messageId: "row1",
      name: "Herdr 编辑器 API 每日检查",
      brief: "检查 Herdr 编辑器 API 有没有变。",
      schedule: { kind: "daily", time: "09:00" },
      timezone: "Asia/Shanghai",
      scheduleText: "every day at 09:00",
    },
  },
} as const;
type Kind = keyof typeof KINDS;

let rows = 0;

const operation = (
  kind: Kind,
  fields: Partial<CaptainOperationView> = {},
): CaptainOperationView => ({
  id: "op1",
  kind,
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

/** A proposal row with an id of its own, so no test inherits another's remembered fold. */
const proposed = (kind: Kind): MessageView =>
  messageView({
    id: `proposal-row-${++rows}`,
    conversationId: "c1",
    kind: "system",
    author: "system",
    text: "",
    data: {
      event: "captain_proposal",
      kind,
      operationId: "op1",
      proposal: KINDS[kind].proposal,
    },
  });

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

async function show(message: MessageView, operations: CaptainOperationView[]) {
  const host = buildProductHost({
    agents: [agentView({ id: "a1", name: "Ada" })],
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
    operation: operations[0],
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
  const fold = container.querySelector("details.task-fold")!;
  return { container, fold, head: fold.querySelector("summary")! };
}

describe("a proposal of Captain's, folded", () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    it(`arrives as one line and opens on a click: ${kind}`, async () => {
      const { fold, head } = await show(proposed(kind), [operation(kind)]);
      const { title, label, detail, proposal } = KINDS[kind];
      expect(fold.hasAttribute("open")).toBe(false);
      // Its name for a screen reader is the one it had before it folded.
      expect(fold.getAttribute("aria-label")).toBe(label);
      // The line is the native control: Enter and Space open it with no handler of ours.
      expect(fold.firstElementChild).toBe(head);
      expect(head.textContent).toContain(title);
      expect(head.textContent).toContain(proposal.name);
      expect(head.textContent).toContain("待确认");
      // What it would be and the answers are below the line, not on it.
      expect(head.textContent).not.toContain(detail);
      expect(head.querySelector("button")).toBeNull();

      await click(head);
      expect(fold.hasAttribute("open")).toBe(true);
      const body = fold.querySelector(".task-fold-body")!;
      expect(body.textContent).toContain(detail);
      expect(button(body, "创建")).toBeDefined();
      expect(button(body, "拒绝")).toBeDefined();

      await click(head);
      expect(fold.hasAttribute("open")).toBe(false);
    });
  }

  it("says where it stands on the folded line", async () => {
    for (const [status, word, tone] of [
      ["pending", "待确认", "neutral"],
      ["applied", "已创建", "success"],
      ["rejected", "已拒绝", "neutral"],
      ["failed", "失败", "error"],
    ] as [CaptainOperationStatus, string, string][]) {
      const { fold, head } = await show(proposed("create_routine"), [
        operation("create_routine", {
          status,
          error: status === "failed" ? "no such timezone" : null,
        }),
      ]);
      expect(fold.hasAttribute("open")).toBe(false);
      expect(head.textContent).toContain(word);
      expect(head.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe(
        tone,
      );
      await cleanup();
      setWire(undefined);
    }
  });

  it("frames the one still waiting, so it reads without opening the card", async () => {
    const pending = await show(proposed("create_agent"), [
      operation("create_agent"),
    ]);
    expect(
      pending.head.querySelector("[data-tone]")?.classList.contains("border"),
    ).toBe(true);
    await cleanup();
    setWire(undefined);
    const made = await show(proposed("create_agent"), [
      operation("create_agent", { status: "applied" }),
    ]);
    expect(
      made.head.querySelector("[data-tone]")?.classList.contains("border"),
    ).toBe(false);
  });

  it("keeps the reader's choice for that row, through being drawn again", async () => {
    const message = proposed("create_group");
    const first = await show(message, [operation("create_group")]);
    await click(first.head);
    expect(first.fold.hasAttribute("open")).toBe(true);
    await cleanup();
    setWire(undefined);
    const again = await show(message, [operation("create_group")]);
    expect(again.fold.hasAttribute("open")).toBe(true);
  });

  it("does not fold on a press inside the body", async () => {
    const { fold, head } = await show(proposed("create_group"), [
      operation("create_group"),
    ]);
    await click(head);
    await act(async () => {
      button(fold, "拒绝")!.click();
    });
    expect(fold.hasAttribute("open")).toBe(true);
  });
});
