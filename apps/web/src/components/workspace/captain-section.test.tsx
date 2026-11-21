import type { ConversationSummary } from "@eta/client-contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("nuqs", () => {
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
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));

/**
 * Captain's row at the head of the sidebar.
 *
 * It keeps its own place at the top, and the card is what sets it apart. The ring around its face
 * is the session's own gauge, the numbers at the end of the row are what that session has spent and
 * how fast it is going, and the task/artifact counts are the only thing left in the title.
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
    spend: {
      input: { value: 12345, coverage: "complete" },
      output: { value: 678, coverage: "complete" },
      cache: { value: 10000, coverage: "complete" },
    },
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
  navigation.navigate.mockClear();
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
  it("是那个会话自己的面板：一个有框的卡片，写着名字和它在做什么", async () => {
    const container = await section();
    const card = container.querySelector(
      '[data-section="captain"] > div',
    ) as HTMLElement;
    expect(card.className).toContain("border");
    const button = card.querySelector("button")!;
    const text = button.textContent ?? "";
    expect(text).toContain("Captain");
    expect(text).toContain("空闲");
  });

  it("速度和用量在行上：tok/s 结尾，成功绿，不藏进提示", async () => {
    const container = await section();
    const button = container.querySelector('[data-section="captain"] button')!;
    const text = button.textContent ?? "";
    expect(text).toContain("12 tok/s");
    expect(text).toContain("12.3k");
    expect(text).toContain("678");
    expect(button.getAttribute("title")).toBeNull();
    const rate = [...button.querySelectorAll("span")].find(
      (each) => each.textContent === "12 tok/s",
    );
    expect(rate?.className).toContain("state-success");
  });

  it("两行：一行是谁和它在做什么，一行是它花了多少", async () => {
    const container = await section();
    const card = container.querySelector(
      '[data-section="captain"] > div',
    ) as HTMLElement;
    const row = card.querySelector("button")!;
    // The face, then one column holding both lines.
    const column = row.lastElementChild as HTMLElement;
    expect(column.children.length).toBe(2);
    const [head, numbers] = [...column.children] as HTMLElement[];
    expect(head.textContent).toContain("Captain");
    expect(head.textContent).toContain("空闲");
    expect(numbers.textContent).toContain("12.3k");
    expect(numbers.textContent).toContain("12 tok/s");
  });

  it("头像比列表里的行大一档：环是 48px 的框", async () => {
    const container = await section();
    const ring = container.querySelector(
      '[data-section="captain"] span[title]',
    ) as HTMLElement | null;
    expect(ring?.style.width).toBe("48px");
    expect(ring?.style.height).toBe("48px");
  });

  it("模型是名字不是计数：落在提示里，不挤在数字中间", async () => {
    const container = await section();
    const text = container.textContent ?? "";
    expect(text).not.toContain("p:m1");
    expect(
      container.querySelector('[data-section="captain"] span[title="p:m1"]'),
    ).not.toBeNull();
  });

  it("点了打开 Captain 的会话", async () => {
    const container = await section();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-section="captain"] button',
    )!;
    await act(async () => button.click());
    expect(navigation.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { group: "g-cap" },
    });
  });

  it("折成图标栏时只剩头像和名字，状态不写", async () => {
    const container = await section(true);
    const button = container.querySelector('[data-section="captain"] button');
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
