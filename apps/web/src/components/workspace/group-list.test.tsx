import type {
  AgentView,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { agentView, conversationView, productHost } from "@/test-product";
import { memberStatusLabels } from "./agent-status";
import { GroupList } from "./groups";

const groups = rstest.hoisted(() => ({ list: [] as ConversationSummary[] }));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: groups.list }),
  useOpenGroup: () => rstest.fn(),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agents: AgentView[] = [];
const member = (agentId: string, status: MemberView["status"]): MemberView => ({
  agentId,
  sessionId: null,
  lastSeq: 0,
  status,
});

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient();
  // The private chats are rows an agent gives its name to: the list pairs each agent with the
  // direct conversation it speaks in, so a conversation alone is not enough to make one appear.
  productHost({ conversations: groups.list, agents });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
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
  agents.length = 0;
  setWire(undefined);
});

describe("最近对话的一行", () => {
  it("names the group's size instead of saying it is empty", async () => {
    groups.list = [
      conversationView({
        id: "g1",
        name: "发布计划",
        participants: [member("a1", "idle"), member("a2", "idle")],
      }),
    ];
    const container = await render(<GroupList />);
    expect(container.textContent).toContain("发布计划");
    expect(container.textContent).toContain(
      translate("chat:groups.members.count", { count: 2 }),
    );
  });

  it("says what was last said when a group has said something", async () => {
    groups.list = [
      conversationView({
        id: "g1",
        name: "发布计划",
        preview: "周五发版",
        participants: [member("a1", "idle")],
      }),
    ];
    const container = await render(<GroupList />);
    expect(container.textContent).toContain("周五发版");
  });

  it("shows a direct chat's agent as busy, and says nothing of its kind", async () => {
    groups.list = [
      conversationView({
        id: "d1",
        name: "小明",
        kind: "direct",
        participants: [member("a1", "working")],
      }),
    ];
    agents.splice(0, agents.length, agentView({ id: "a1", name: "小明" }));
    const container = await render(<GroupList />);
    expect(container.textContent).toContain(memberStatusLabels.working);
    expect(container.textContent).not.toContain(
      translate("chat:groups.directChat"),
    );
  });

  it("falls back to the preview once that agent is idle again", async () => {
    groups.list = [
      conversationView({
        id: "d1",
        name: "小明",
        kind: "direct",
        preview: "晚安",
        participants: [member("a1", "idle")],
      }),
    ];
    agents.splice(0, agents.length, agentView({ id: "a1", name: "小明" }));
    const container = await render(<GroupList />);
    expect(container.textContent).toContain("晚安");
    expect(container.textContent).not.toContain(memberStatusLabels.idle);
  });
});
