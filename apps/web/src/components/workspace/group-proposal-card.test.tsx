import type {
  CaptainGroupProposal,
  CaptainGroupProposalRowData,
  CaptainOperationView,
  MessageView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { Chat } from "@/test-chat";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
  productHost,
} from "@/test-product";
import { flush } from "@/test-render";

// A group Captain proposed, drawn as a card in Captain's conversation: what it would be, the two
// answers while it waits, and how it ended, read from the same operation the panel lists.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let conversations = 0;

const proposal = (
  fields: Partial<CaptainGroupProposal> = {},
): CaptainGroupProposal => ({
  originConversationId: "",
  messageId: "",
  name: "发布",
  goal: "上线发布页",
  memberIds: ["a1", "a2"],
  stewardId: "a2",
  projectId: null,
  machineId: "m1",
  path: "/home/me/small-repo",
  projectName: "small-repo",
  ...fields,
});

const operation = (
  status: CaptainOperationView["status"],
  fields: Partial<CaptainOperationView> = {},
): CaptainOperationView => ({
  id: "op1",
  kind: "create_group",
  actorAgentId: "cap",
  requiresApproval: true,
  status,
  payload: {},
  result: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

const disposers: (() => void)[] = [];
afterEach(async () => {
  await act(async () => disposers.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
});

async function show(
  operations: CaptainOperationView[],
  rowFields: Partial<CaptainGroupProposalRowData> = {},
  shown: Partial<CaptainGroupProposal> = {},
) {
  conversations += 1;
  const id = `c-proposal-${conversations}`;
  const summary = conversationView({
    id,
    name: "Captain",
    kind: "direct",
    participants: [memberView("cap")],
  });
  const data: CaptainGroupProposalRowData = {
    event: "captain_group_proposal",
    operationId: "op1",
    proposal: proposal({
      originConversationId: id,
      messageId: `row-${conversations}`,
      ...shown,
    }),
    status: "pending",
    result: null,
    error: null,
    ...rowFields,
  };
  const row: MessageView = messageView({
    id: `row-${conversations}`,
    conversationId: id,
    kind: "system",
    author: "system",
    text: "Captain proposed the group",
    data: { ...data },
  });
  const host = productHost({
    agents: [
      agentView({ id: "cap", name: "Captain" }),
      agentView({ id: "a1", name: "Ada" }),
      agentView({ id: "a2", name: "Bola" }),
    ],
    conversations: [summary],
    messages: { [id]: [row] },
  });
  host.target(
    "captain",
    {
      identity: null,
      assignments: [],
      operations,
      notifications: [],
      memoryPauses: [],
      settings: {},
    },
    { eager: true },
  );
  host.handle("captain.decideOperation", (args) => ({
    operation: operation(
      (args as { decision: string }).decision === "approve"
        ? "applied"
        : "rejected",
    ),
  }));
  host.hello();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <Chat conversationId={id} />
        </NuqsAdapter>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  disposers.push(() => {
    root.unmount();
    container.remove();
  });
  await flush();
  const card = () =>
    container.querySelector<HTMLElement>('section[aria-label^="提议的群"]');
  return { host, card };
}

const button = (card: HTMLElement, text: string) =>
  [...card.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );

describe("a group Captain proposes", () => {
  it("says what it would be, and waits for create or reject", async () => {
    const { card, host } = await show([operation("pending")]);
    const shown = card()!;
    expect(shown.textContent).toContain("发布");
    expect(shown.textContent).toContain("small-repo");
    expect(shown.textContent).toContain("新项目");
    expect(shown.textContent).toContain("/home/me/small-repo");
    expect(shown.textContent).toContain("Ada, Bola");
    expect(shown.textContent).toContain("主理人Bola");
    expect(shown.textContent).toContain("上线发布页");
    expect(shown.textContent).toContain("待确认");
    expect(shown.querySelector("a")).toBeNull();

    await act(async () => button(shown, "创建")!.click());
    await flush();
    expect(
      host.calls.find((call) => call.action === "decideOperation")?.args,
    ).toEqual({ operationId: "op1", decision: "approve" });
  });

  it("can be rejected", async () => {
    const { card, host } = await show(
      [operation("pending")],
      {},
      {
        projectId: "p1",
        goal: null,
      },
    );
    const shown = card()!;
    // A project that already exists is not new, and a group with no goal has no goal line.
    expect(shown.textContent).not.toContain("新项目");
    expect(shown.textContent).not.toContain("目标");
    await act(async () => button(shown, "拒绝")!.click());
    await flush();
    expect(
      host.calls.find((call) => call.action === "decideOperation")?.args,
    ).toEqual({ operationId: "op1", decision: "reject" });
  });

  it("links to the group it made", async () => {
    const { card } = await show([
      operation("applied", {
        result: {
          conversationId: "g-new",
          projectId: "p1",
          projectCreated: true,
        },
      }),
    ]);
    const shown = card()!;
    expect(shown.textContent).toContain("已创建");
    expect(button(shown, "创建")).toBeUndefined();
    expect(shown.querySelector("a")?.getAttribute("href")).toContain(
      "group=g-new",
    );
  });

  it("says why it failed", async () => {
    const { card } = await show([
      operation("failed", {
        error:
          'a group named "发布" already exists in this project (conversationId g1)',
      }),
    ]);
    const shown = card()!;
    expect(shown.textContent).toContain("失败");
    expect(shown.querySelector('[role="alert"]')?.textContent).toContain(
      "already exists",
    );
    expect(button(shown, "创建")).toBeUndefined();
  });

  it("is drawn from its own row once the operation left the published list", async () => {
    const { card } = await show([], { status: "rejected" });
    const shown = card()!;
    expect(shown.textContent).toContain("已拒绝");
    expect(button(shown, "创建")).toBeUndefined();
  });
});

describe("a group Captain made", () => {
  it("opens with the line that says so", async () => {
    conversations += 1;
    const id = `c-made-${conversations}`;
    const summary = conversationView({ id, name: "发布" });
    productHost({
      conversations: [summary],
      messages: {
        [id]: [
          messageView({
            id: `made-${conversations}`,
            conversationId: id,
            kind: "system",
            author: "system",
            text: "Created by Captain.",
            data: { event: "captain_created", operationId: "op1" },
          }),
        ],
      },
    });
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => (
          <NuqsAdapter>
            <Chat conversationId={id} />
          </NuqsAdapter>
        ),
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await router.load();
    });
    disposers.push(() => {
      root.unmount();
      container.remove();
    });
    await flush();
    expect(
      [...container.querySelectorAll(".system-message")].map(
        (line) => line.textContent,
      ),
    ).toContain("由 Captain 创建");
  });
});
