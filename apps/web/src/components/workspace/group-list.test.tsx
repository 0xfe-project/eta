import type {
  AgentView,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import {
  agentView,
  buildProductHost,
  conversationView,
  productHost,
} from "@/test-product";
import { cleanup, mount } from "@/test-render";
import { agentStatusLabels } from "./agent-status";
import { GroupList } from "./groups";

const groups = rstest.hoisted(() => ({ list: [] as ConversationSummary[] }));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: groups.list }),
  useOpenGroup: () => rstest.fn(),
}));

const agents: AgentView[] = [];
const member = (agentId: string, status: MemberView["status"]): MemberView => ({
  agentId,
  sessionId: null,
  lastSeq: 0,
  status,
});

async function render(node: React.ReactNode) {
  // The private chats are rows an agent gives its name to: the list pairs each agent with the
  // direct conversation it speaks in, so a conversation alone is not enough to make one appear.
  productHost({ conversations: groups.list, agents });
  return (await mount(node)).container;
}

afterEach(async () => {
  await cleanup();
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
    expect(container.textContent).toContain(agentStatusLabels.working);
    expect(container.textContent).not.toContain(
      translate("chat:groups.directChat"),
    );
  });

  it("draws the rows' outline until hello, and not the empty line", async () => {
    groups.list = [];
    // Connected, but `hello` has not come: nothing is known about the list yet.
    buildProductHost({ conversations: [], agents }).install();
    const { container } = await mount(<GroupList />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      translate("chat:groups.empty.title"),
    );
  });

  it("says the list is empty once it has arrived, with no outline left", async () => {
    groups.list = [];
    const container = await render(<GroupList />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain(
      translate("chat:groups.empty.title"),
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
    expect(container.textContent).not.toContain(agentStatusLabels.idle);
  });
});
