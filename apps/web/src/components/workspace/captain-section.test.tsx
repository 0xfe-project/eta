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
 * Captain's block at the head of the sidebar.
 *
 * What this file holds it to is the thing it got wrong the first time round: it is not a button
 * that opens a conversation, it is the conversation's own panel — the ring and the numbers that
 * 成员 draws for any other session, on Captain's session.
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
    notifications: [],
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
  it("是那个会话自己的面板：环套在头像上，下面是它的模型和用量", async () => {
    const container = await section();
    // The gauge is the group panel's own, drawn around the face rather than beside it.
    const ring = container.querySelector('[data-section="captain"] svg');
    expect(ring).not.toBeNull();
    // The window it drew: the title the ring carries is the panel's wording.
    const title =
      container.querySelector("span[title]")?.getAttribute("title") ?? "";
    expect(title).toContain("128k");
    // And the same numbers 成员 shows, off the same session. The model is on the row as its
    // title rather than as text: it is a name, and the row has counts to carry.
    const text = container.textContent ?? "";
    expect(text).not.toContain("p:m1");
    expect(
      container.querySelector('[data-section="captain"] span[title="p:m1"]'),
    ).not.toBeNull();
    expect(text).toContain("12.3k");
    expect(text).toContain("678");
    expect(text).toContain("10.0k");
  });

  it("头像比列表里的行大一档，但只是半个海报：环是 48px 的框", async () => {
    const container = await section();
    const ring = container.querySelector(
      '[data-section="captain"] span[title]',
    ) as HTMLElement | null;
    expect(ring?.style.width).toBe("48px");
    expect(ring?.style.height).toBe("48px");
  });

  it("整张卡片是一行：头像、名字、状态、数字都在同一条线上", async () => {
    const container = await section();
    const card = container.querySelector(
      '[data-section="captain"] > div',
    ) as HTMLElement;
    // The card is the row, and nothing else: no stats block under it, no counts block under that.
    expect(card.children.length).toBe(1);
    expect(card.querySelector(".border-t")).toBeNull();
    const row = card.firstElementChild as HTMLElement;
    // Every child of the row is inline, so none of them can start a line of its own.
    for (const each of [...row.children]) expect(each.tagName).toBe("SPAN");
    const text = row.textContent ?? "";
    expect(text).toContain("Captain");
    expect(text).toContain("空闲");
    expect(text).toContain("12.3k");
    expect(text).toContain("678");
    expect(text).toContain("10.0k");
  });

  it("卡片上方没有 CAPTAIN 这一行标签：卡片自己说得清自己是什么", async () => {
    const container = await section();
    expect(container.querySelector("#sidebar-captain")).toBeNull();
    const group = container.querySelector('[data-section="captain"]');
    // The card is the first thing in the section, not a heading and then a card.
    expect(group?.firstElementChild?.className).toContain("border");
  });

  it("点了打开 Captain 的会话", async () => {
    const container = await section();
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.getAttribute("type")).toBe("button");
    expect(container.textContent).toContain("Captain");
  });

  it("折成图标栏时只留头像，名字留给读屏", async () => {
    const container = await section(true);
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.getAttribute("aria-label")).toBe("Captain");
    // No name drawn: 4rem of rail is one glyph.
    expect(button?.textContent).toBe("");
  });

  it("卡片带「运营 · N」：N 是要人处理的审批加未读告警", async () => {
    host.target("captain", {
      identity: captain,
      operations: [
        { id: "o1", kind: "task.create", status: "pending" },
        { id: "o2", kind: "task.close", status: "approved" },
      ],
      notifications: [
        { id: "n1", kind: "stuck", body: "卡住了", readAt: null },
        { id: "n2", kind: "stuck", body: "老的", readAt: 5 },
      ],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section();
    await flush();
    const badge = container.querySelector("[data-captain-waiting]");
    expect(badge?.textContent).toBe("运营 · 2");
    // Nothing waiting, nothing said: the card does not carry a 0.
    expect(container.textContent).not.toContain("运营 · 0");
  });

  it("折成图标栏时把同一个数留在环的角上，名字留给读屏", async () => {
    host.target("captain", {
      identity: captain,
      operations: [{ id: "o1", kind: "task.create", status: "pending" }],
      notifications: [],
      assignments: [],
      memoryPauses: [],
      settings: {},
    });
    const container = await section(true);
    await flush();
    const button = container.querySelector('[data-section="captain"] button');
    expect(button?.getAttribute("aria-label")).toBe("Captain · 运营 · 1");
    expect(button?.querySelector("[data-captain-waiting]")?.textContent).toBe(
      "1",
    );
  });

  it("没有 Captain 时整块不出现", async () => {
    host.target("captain", { identity: null });
    const container = await section();
    await flush();
    expect(container.querySelector('[data-section="captain"]')).toBeNull();
  });
});
