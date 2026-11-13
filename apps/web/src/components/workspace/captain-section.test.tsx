import type { ConversationSummary } from "@eta/client-contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { CaptainSection } from "./sidebar-tree";

const navigation = rstest.hoisted(() => ({ navigate: rstest.fn() }));
rstest.mock("nuqs", () => {
  const parser = ({ parse }: { parse: (value: string | null) => unknown }) => {
    const self = {
      parse,
      serialize: (value: unknown) => value,
      withDefault: () => self,
      withOptions: () => self,
    };
    return self;
  };
  return {
    createParser: parser,
    parseAsString: {},
    useQueryState: () => [null],
  };
});
rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));

/**
 * Captain's row at the head of the sidebar.
 *
 * It keeps its own place at the top, and nothing else sets it apart: it is an agent row like the
 * ones below — the same face, the same hover, no frame, no colour of its own. The session's rate
 * and counts are in the title, and what it holds for a person is a plain number.
 */

let host: ReturnType<typeof productHost>;

const captain = {
  agentId: "cap",
  name: "Captain",
  home: "/data/agents/cap",
  model: "p:m1",
  conversationId: "g-cap",
  createdAt: 1,
};

/** The conversation Captain lives in: one member, whose session the ring and the numbers read. */
function captainConversation(): ConversationSummary {
  return conversationView({
    id: "g-cap",
    kind: "group",
    name: "Captain",
    participants: [memberView("cap", { sessionId: "s1" })],
  });
}

/** One session with numbers worth reading: a model, and what it has spent. */
function session() {
  return {
    core: { session: "s1", running: false },
    model: { id: "p:m1", thinkingLevel: "off" },
    transcript: { messages: [] },
    prompt: { stableChars: 800, adaptiveChars: 2000, sections: [] },
    tools: [],
    usage: { input: 12_345, output: 678, cacheRead: 9_000, cacheWrite: 1_000 },
    metrics: { tokensPerSec: 12 },
  };
}

function providers() {
  return {
    config: {
      revision: "r1",
      providers: [
        {
          id: "p",
          name: "P",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          hasApiKey: true,
          models: [{ id: "m1", name: "M1", contextWindow: 128_000 }],
        },
      ],
    },
  };
}

beforeEach(() => {
  host = productHost({
    agents: [agentView({ id: "cap", name: "Captain" })],
    projects: [projectView({ id: "p", name: "p", path: "/p" })],
    conversations: [captainConversation()],
  });
  host.target("captain", {
    identity: captain,
    assignments: [],
    operations: [],
    memoryPauses: [],
    settings: {},
  });
  host.target("providers", providers(), { eager: true });
  host.target("sessions.s1", session());
  host.handle("sessions.resync", () => ({}));
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

async function section(rail = false) {
  const { container } = await mount(
    <SidebarProvider>
      <CaptainSection rail={rail} />
    </SidebarProvider>,
  );
  await flush();
  return container;
}

describe("Captain 在左栏顶上", () => {
  it("和其他智能体同一种行：没有外框、没有环，头像是行的大小", async () => {
    const container = await section();
    const group = container.querySelector('[data-section="captain"]')!;
    // No gauge ring around the face: that box was 48px.
    expect(group.querySelector('[style*="48px"]')).toBeNull();
    expect(group.querySelector(".border")).toBeNull();
    const button = group.querySelector("button")!;
    expect(button.className).toContain("hover:bg-sidebar-accent");
    expect(button.className).toContain("px-4");
    expect(button.querySelector(".size-6")).not.toBeNull();
    expect(button.querySelector(".size-10")).toBeNull();
    const text = button.textContent ?? "";
    expect(text).toContain("Captain");
    expect(text).toContain("空闲");
  });

  it("速度和用量不在行上：tok/s 挪进悬停提示，也不用成功绿", async () => {
    const container = await section();
    const button = container.querySelector('[data-section="captain"] button')!;
    expect(button.textContent).not.toContain("tok/s");
    expect(button.textContent).not.toContain("12.3k");
    expect(button.getAttribute("title")).toBe("Captain · 12 tok/s");
    expect(container.innerHTML).not.toContain("state-success");
  });

  it("点了打开 Captain 的会话", async () => {
    const container = await section();
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.getAttribute("type")).toBe("button");
    expect(container.textContent).toContain("Captain");
  });

  it("折成图标栏时和其他行一样：头像，名字在下面", async () => {
    const container = await section(true);
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.className).toContain("flex-col");
    expect(button?.querySelector(".size-6")).not.toBeNull();
    expect(button?.textContent).toBe("Captain");
  });

  it("待处理只是一个中性的数字：只数待审批的操作，名字留给读屏", async () => {
    host.target("captain", {
      identity: captain,
      operations: [
        { id: "o1", kind: "task.create", status: "pending" },
        { id: "o2", kind: "task.close", status: "approved" },
        { id: "o3", kind: "delete_agent", status: "pending" },
        { id: "o4", kind: "create_group", status: "rejected" },
      ],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section();
    await flush();
    const badge = container.querySelector("[data-captain-waiting]");
    expect(badge?.textContent).toBe("2");
    expect(badge?.className).toContain("bg-muted");
    expect(badge?.className).not.toContain("state-");
    expect(container.querySelector(".sr-only")?.textContent).toBe("待审批 · 2");
  });

  it("旧 host 还发来的未读告警不算进数字", async () => {
    host.target("captain", {
      identity: captain,
      operations: [{ id: "o1", kind: "task.create", status: "pending" }],
      notifications: [
        { id: "n1", kind: "stuck", body: "卡住了", readAt: null },
        { id: "n2", kind: "task_retry_stopped", body: "停了", readAt: null },
      ],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section();
    await flush();
    expect(container.querySelector("[data-captain-waiting]")?.textContent).toBe(
      "1",
    );
    expect(container.querySelector(".sr-only")?.textContent).toBe("待审批 · 1");
  });

  it("审批完了数字就消失，哪怕旧 host 还有未读告警", async () => {
    host.target("captain", {
      identity: captain,
      operations: [{ id: "o1", kind: "task.create", status: "approved" }],
      notifications: [
        { id: "n1", kind: "stuck", body: "卡住了", readAt: null },
      ],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section();
    await flush();
    expect(container.querySelector("[data-captain-waiting]")).toBeNull();
    expect(container.querySelector(".sr-only")).toBeNull();
  });

  it("没有要处理的就不画数字", async () => {
    const container = await section();
    expect(container.querySelector("[data-captain-waiting]")).toBeNull();
    expect(container.textContent).not.toContain("待审批");
  });

  it("折成图标栏时把同一个数留在角上，读屏读得到", async () => {
    host.target("captain", {
      identity: captain,
      operations: [{ id: "o1", kind: "task.create", status: "pending" }],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section(true);
    await flush();
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.querySelector("[data-captain-waiting]")?.textContent).toBe(
      "1",
    );
    expect(button?.querySelector(".sr-only")?.textContent).toBe("待审批 · 1");
  });

  it("没有 Captain 时整块不出现", async () => {
    host.target("captain", { identity: null });
    const container = await section();
    await flush();
    expect(container.querySelector('[data-section="captain"]')).toBeNull();
  });
});
