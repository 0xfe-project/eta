import type { MessageView } from "@eta/client-contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { agentView, messageView, productHost } from "@/test-product";
import { cleanup, mount } from "@/test-render";
import { ChatPanel } from "./chat-panel";
import { useWorkspaceStore } from "./workspace-store";

rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: (options?: { select?: (state: unknown) => unknown }) =>
    options?.select
      ? options.select({ location: { pathname: "/" } })
      : { location: { pathname: "/" } },
  useRouter: () => ({ navigate: () => undefined }),
  useNavigate: () => () => undefined,
  useLocation: (options?: { select?: (location: unknown) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => () => undefined,
}));

const globals = globalThis as Record<string, unknown>;
const realResize = globals.ResizeObserver;
const realIntersection = globals.IntersectionObserver;

/** The resize callbacks and the top-of-transcript watchers that are live. */
let resizes: (() => void)[];
let tops: ((entries: { isIntersecting: boolean }[]) => void)[];

beforeEach(() => {
  resizes = [];
  tops = [];
  globals.ResizeObserver = class {
    private readonly run: () => void;
    constructor(run: () => void) {
      this.run = run;
      resizes.push(run);
    }
    observe() {}
    disconnect() {
      resizes = resizes.filter((run) => run !== this.run);
    }
  };
  globals.IntersectionObserver = class {
    private readonly run: (entries: { isIntersecting: boolean }[]) => void;
    constructor(run: (entries: { isIntersecting: boolean }[]) => void) {
      this.run = run;
      tops.push(run);
    }
    observe() {}
    disconnect() {
      tops = tops.filter((run) => run !== this.run);
    }
  };
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  globals.ResizeObserver = realResize;
  globals.IntersectionObserver = realIntersection;
  useWorkspaceStore.getState().setWorkspace({ transcriptRail: false });
});

const VIEWPORT = 600;
const LONG = 24_000;

/** A browser's scroller, reduced to what the transcript reads and writes. */
function geometry(el: HTMLElement) {
  const view = { height: VIEWPORT, top: 0, client: VIEWPORT };
  const most = () => Math.max(0, view.height - view.client);
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => view.height },
    clientHeight: { configurable: true, get: () => view.client },
    scrollTop: {
      configurable: true,
      get: () => (view.top = Math.min(view.top, most())),
      set: (value: number) => (view.top = Math.max(0, Math.min(value, most()))),
    },
  });
  return view;
}

const rows = (conversationId: string, count = 3): MessageView[] =>
  Array.from({ length: count }, (_, i) =>
    messageView({ conversationId, text: `${conversationId}-${i}` }),
  );

interface Open {
  groupId: string;
  messages?: readonly MessageView[];
  loading?: boolean;
  hasOlder?: boolean;
}

async function chat(first: Open) {
  productHost({ agents: [agentView({ id: "a1", name: "乐子人" })] });
  const loadOlder = rstest.fn();
  const panel = ({ groupId, messages = [], loading, hasOlder }: Open) => (
    <ChatPanel
      groupId={groupId}
      groupName={undefined}
      held={[]}
      agents={[]}
      messages={messages}
      loading={loading ?? false}
      hasOlder={hasOlder ?? false}
      loadingOlder={false}
      onLoadOlder={loadOlder}
      questions={[]}
      draft={[]}
      onDraftChange={() => {}}
      onSend={() => {}}
      onCompact={() => {}}
      onStop={() => {}}
      onStopAll={() => {}}
      onChoose={() => {}}
      onAbort={() => {}}
      onGoal={async () => undefined}
      outgoing={[]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
      onResend={() => {}}
    />
  );
  const { container, show } = await mount(panel(first));
  const el = container.querySelector<HTMLElement>(".no-scrollbar")!;
  const view = geometry(el);
  return {
    container,
    el,
    view,
    loadOlder,
    open: (next: Open) => show(panel(next)),
    /** The scroll event the browser queued, which it delivers at the start of a frame. */
    scrollEvent: () =>
      act(async () => {
        el.dispatchEvent(new Event("scroll"));
      }),
    /** The resize observers, which run later in the same frame. */
    resized: () =>
      act(async () => {
        resizes.forEach((run) => run());
      }),
    hand: () =>
      act(async () => {
        el.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
        );
      }),
    topInView: () =>
      act(async () => {
        tops.forEach((run) => run([{ isIntersecting: true }]));
      }),
    offered: () =>
      container.textContent?.includes(translate("chat:rail.newActivity")),
    atEnd: () => view.top === Math.max(0, view.height - view.client),
  };
}

/** A long conversation, opened and at its end. */
async function atTheEnd(hasOlder = false) {
  const page = await chat({ groupId: "g1", messages: rows("g1"), hasOlder });
  page.view.height = LONG;
  await page.resized();
  await page.scrollEvent();
  expect(page.atEnd()).toBe(true);
  return page;
}

describe("切换群聊时落在最后一条", () => {
  it("内容变短 → 变长 → 才派发 scroll 事件，仍然贴底", async () => {
    const page = await atTheEnd();
    // One task: the next conversation's few rows, which the browser clamps the view down to.
    page.view.height = 800;
    await page.open({ groupId: "g2", messages: rows("g2"), loading: true });
    expect(page.view.top).toBe(200);
    // The next task, before the frame: the rest of it.
    page.view.height = LONG;
    await page.open({ groupId: "g2", messages: rows("g2", 200) });
    await page.scrollEvent();
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });

  it("同样的先短后长，没有任何代码动过滚动位置，也不算离开", async () => {
    const page = await atTheEnd();
    // A card folds, and the browser clamps; more output lands before the frame.
    page.view.height = LONG - 5000;
    expect(page.el.scrollTop).toBe(LONG - 5000 - VIEWPORT);
    page.view.height = LONG + 2000;
    await page.scrollEvent();
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });

  it("离屏行换回真实高度，内容在 scroll 事件之前长高，不算离开", async () => {
    const page = await atTheEnd();
    page.view.height = LONG + 45;
    await page.scrollEvent();
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });

  it("上一个群聊往上翻过，不把它的位置带过来", async () => {
    const page = await atTheEnd();
    page.view.top = 5000;
    await page.scrollEvent();
    expect(page.offered()).toBe(true);
    page.view.height = LONG * 2;
    await page.open({ groupId: "g2", messages: rows("g2", 200) });
    expect(page.atEnd()).toBe(true);
    // The other end of the same conversation arrives, and the first row changes.
    page.view.height = LONG * 3;
    await page.open({ groupId: "g2", messages: rows("g2", 300) });
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });

  it("新内容就绪之前不往上加载", async () => {
    const page = await chat({ groupId: "g1", messages: rows("g1") });
    const cached = rows("g2", 2);
    await page.open({
      groupId: "g2",
      messages: cached,
      loading: true,
      hasOlder: true,
    });
    await page.topInView();
    expect(page.loadOlder).not.toHaveBeenCalled();
    await page.open({ groupId: "g2", messages: cached, hasOlder: true });
    await page.topInView();
    expect(page.loadOlder).toHaveBeenCalledTimes(1);
  });
});

describe("读者的动作照常算数", () => {
  it("往上滚动解除贴底，新消息不把人拽回去，「新动态」出现", async () => {
    const page = await atTheEnd();
    page.view.top = 9000;
    await page.scrollEvent();
    expect(page.offered()).toBe(true);
    page.view.height = LONG + 3000;
    await page.resized();
    expect(page.view.top).toBe(9000);
    expect(page.offered()).toBe(true);
  });

  it("流式输出的同一帧里滚轮往上，也算离开", async () => {
    const page = await atTheEnd();
    await page.hand();
    page.view.top = 9000;
    page.view.height = LONG + 300;
    await page.scrollEvent();
    await page.resized();
    expect(page.view.top).toBe(9000);
    expect(page.offered()).toBe(true);
  });

  it("贴底附近的一下滚轮不算离开", async () => {
    const page = await atTheEnd();
    await page.hand();
    page.view.top -= 20;
    await page.scrollEvent();
    expect(page.offered()).toBe(false);
  });

  it("滚回底部恢复跟随", async () => {
    const page = await atTheEnd();
    page.view.top = 9000;
    await page.scrollEvent();
    page.view.top = LONG - VIEWPORT;
    await page.scrollEvent();
    expect(page.offered()).toBe(false);
    page.view.height = LONG + 300;
    await page.resized();
    expect(page.atEnd()).toBe(true);
  });

  it("往上加载更早消息时，到底部的距离不变", async () => {
    const messages = rows("g1");
    const page = await chat({ groupId: "g1", messages, hasOlder: true });
    page.view.height = LONG;
    await page.resized();
    page.view.top = 300;
    await page.scrollEvent();
    await page.topInView();
    expect(page.loadOlder).toHaveBeenCalled();
    page.view.height = LONG + 4000;
    await page.open({
      groupId: "g1",
      messages: [...rows("g1", 50), ...messages],
      hasOlder: true,
    });
    await page.scrollEvent();
    await page.resized();
    expect(page.view.top).toBe(4300);
    expect(page.offered()).toBe(true);
  });

  it("轨道跳转后不被拽回底部，刚起步还贴着底时也是", async () => {
    useWorkspaceStore.getState().setWorkspace({ transcriptRail: true });
    const messages = rows("g1", 4);
    const page = await chat({ groupId: "g1", messages });
    page.view.height = LONG;
    await page.resized();
    const row = page.el.querySelector<HTMLElement>(
      `[data-mid="${messages[0]!.id}"]`,
    )!;
    row.getBoundingClientRect = () => ({ top: -9000 }) as DOMRect;
    row.scrollIntoView = rstest.fn();
    await act(async () => {
      page.container.querySelector<HTMLElement>('[title^="1 ·"]')!.click();
    });
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
    // Output lands before the scroll sets off, and the browser's anchoring carries the view down.
    page.view.height = LONG + 90;
    page.view.top = LONG + 90 - VIEWPORT;
    await page.scrollEvent();
    await page.resized();
    expect(page.offered()).toBe(true);
    // The first frames of the smooth scroll, still within the bottom's 32px, with output landing.
    page.view.top -= 10;
    page.view.height = LONG + 100;
    await page.scrollEvent();
    await page.resized();
    expect(page.view.top).toBe(LONG + 90 - VIEWPORT - 10);
    expect(page.offered()).toBe(true);
    // Further up, rows resolve their height and the bottom comes to meet it, mid-flight.
    page.view.top = 9000;
    await page.scrollEvent();
    page.view.height = 9000 + VIEWPORT;
    await page.scrollEvent();
    await page.resized();
    expect(page.offered()).toBe(true);
    // It lands, and the bottom is the reader's to go back to.
    page.view.height = LONG;
    page.view.top = 5000;
    await page.scrollEvent();
    page.view.top = 6000;
    await page.scrollEvent();
    page.view.top = LONG - VIEWPORT;
    await page.scrollEvent();
    expect(page.offered()).toBe(false);
  });

  it("轨道跳到几乎就在眼前的行，不算离开", async () => {
    useWorkspaceStore.getState().setWorkspace({ transcriptRail: true });
    const messages = rows("g1", 4);
    const page = await chat({ groupId: "g1", messages });
    page.view.height = LONG;
    await page.resized();
    const row = page.el.querySelector<HTMLElement>(
      `[data-mid="${messages[0]!.id}"]`,
    )!;
    row.getBoundingClientRect = () => ({ top: -10 }) as DOMRect;
    row.scrollIntoView = rstest.fn();
    await act(async () => {
      page.container.querySelector<HTMLElement>('[title^="1 ·"]')!.click();
    });
    page.view.height = LONG + 300;
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });
});

describe("贴底跟随", () => {
  it("流式输出长高时跟着走", async () => {
    const page = await atTheEnd();
    for (const height of [LONG + 100, LONG + 200, LONG + 900]) {
      page.view.height = height;
      await page.resized();
      expect(page.atEnd()).toBe(true);
    }
    expect(page.offered()).toBe(false);
  });

  it("窗口或面板变矮时跟着走", async () => {
    const page = await atTheEnd();
    page.view.client = 300;
    await page.resized();
    expect(page.atEnd()).toBe(true);
    expect(page.offered()).toBe(false);
  });
});
