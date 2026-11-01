import type { RouterContext } from "@/lib/query-client";
import type { FakeHost } from "@/test-wire";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { act } from "react";
import { createRoot } from "react-dom/client";
// `settingsIntent` is the one thing exported on purpose: the rules below are what the listener
// applies, and a keypress has to be argued about somewhere the listener is not needed to read them.
import { settingsIntent } from "@/lib/settings-shortcut";
import { setWire } from "@/lib/wire";
import { RootDocument } from "@/pages/root-document";
import { agentView, buildProductHost } from "@/test-product";
import { flush } from "@/test-render";
import { AgentEditor } from "./agent-editor";
import { NewConversationDialog } from "./new-conversation-dialog";
import { SettingsDialog } from "./settings-dialog";
import { useWorkspaceStore } from "./workspace-store";

// ⌘, from anywhere. The chord is one listener on `window` (`lib/settings-shortcut.ts`) and the root
// document mounts it, so what these tests hold is the whole promise: it opens settings wherever you
// have navigated to and whatever has focus, and it keeps quiet about a key that meant something
// else. The router is real and the pages under it draw nothing: "any page" is the point, and on a
// phone settings is a route, so where the chord sent you is read out of the address bar.

const disposers: (() => void)[] = [];
/** Which width the page thinks it is at; the phone's settings is a page, not a dialog. */
let phone = false;
/** Which machine the page runs on; `navigator.platform` is read-only, so it is replaced here. */
let platform = "MacIntel";
Object.defineProperty(window.navigator, "platform", {
  configurable: true,
  get: () => platform,
});

/** Pretend to be a Windows box: the chord's other half. */
const onWindows = () => {
  platform = "Win32";
};

/**
 * A phone is a media query. The tests say which side of the breakpoint they are on rather than
 * trusting whatever viewport the test browser happens to have.
 */
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767") && phone,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

/** The product's plugins, and one agent so the settings rail has something to list. */
function host(): FakeHost {
  const fake = buildProductHost(
    { agents: [agentView({ id: "a1", name: "乐子人" })] },
    ["inbox"],
  ).target("inbox", { list: [], approvals: { tools: [] } }, { eager: true });
  fake.install();
  fake.hello();
  return fake;
}

/**
 * The app as it stands: the root document, which is where the chord is mounted, over a routed page,
 * with the layers it opens beside the outlet. Which page is under it is not what is under test —
 * that no page is outside its reach is — so the routes themselves draw nothing.
 */
async function start(path = "/") {
  const root = createRootRoute<RouterContext>({
    component: () => (
      <RootDocument>
        {/* The layers settings opens over a page. The shipped app mounts them in its shell; here
            they stand beside the outlet, which is the same place in the tree. */}
        <Outlet />
        <SettingsDialog />
        <AgentEditor />
        <NewConversationDialog />
      </RootDocument>
    ),
  });
  const blank = () => null;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: blank }),
      createRoute({
        getParentRoute: () => root,
        path: "tasks",
        component: blank,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "settings",
        component: blank,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient } satisfies RouterContext,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createRoot(container);
  await act(async () =>
    app.render(
      <QueryClientProvider client={queryClient}>
        <NuqsTestingAdapter>
          <RouterProvider router={router} />
        </NuqsTestingAdapter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => router.load());
  disposers.push(() => app.unmount());
  await flush();
  return router;
}

/** Press ⌘, the way a Mac does; `{ windows: true }` presses Ctrl+, instead. */
const chord = (
  init: Partial<KeyboardEventInit> & { windows?: boolean } = {},
): KeyboardEvent => {
  const { windows, ...rest } = init;
  const event = new KeyboardEvent("keydown", {
    key: ",",
    bubbles: true,
    cancelable: true,
    ...(windows ? { ctrlKey: true } : { metaKey: true }),
    ...rest,
  });
  act(() => window.dispatchEvent(event));
  return event;
};

/** Press it in an app that is up, and report what the key was answered with. */
async function press(
  init: Parameters<typeof chord>[0] = {},
  path?: string,
): Promise<KeyboardEvent> {
  await start(path);
  const event = chord(init);
  await flush();
  return event;
}

const open = () => useWorkspaceStore.getState().settings.open;
/** One open dialog is what radix leaves in the document: its content and its overlay. */
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
/** Settings' rail, once the dialog is up. */
const rail = () =>
  [...document.querySelectorAll("nav button")].map(
    (row) => row.textContent ?? "",
  );
/** Which rail entry the page says you are on. */
const highlighted = () =>
  document.querySelector("nav button[aria-current]")?.textContent ?? "";

afterEach(async () => {
  await act(async () => disposers.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  phone = false;
  platform = "MacIntel";
  useWorkspaceStore.setState({
    settings: { open: false, section: "agents" },
    agentEditor: { open: false, agentId: null },
    newConversation: { open: false },
  });
  document.body.innerHTML = "";
});

describe("这个键意不意", () => {
  // The rules the listener applies, in one place: the machine decides which key ⌘ goes with, an
  // input method's composition outranks it, and another dialog outranks it on a wide window only.
  const press_ = (init: Record<string, boolean | string> = {}) =>
    ({
      key: ",",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      ...init,
    }) as Parameters<typeof settingsIntent>[0];

  it("Mac 认 ⌘,，别的机器认 Ctrl+,", () => {
    expect(
      settingsIntent(press_({ metaKey: true }), "MacIntel", false, false),
    ).toBe("dialog");
    expect(
      settingsIntent(press_({ ctrlKey: true }), "MacIntel", false, false),
    ).toBe("ignore");
    expect(
      settingsIntent(press_({ ctrlKey: true }), "Win32", false, false),
    ).toBe("dialog");
    expect(
      settingsIntent(press_({ ctrlKey: true }), "Linux", false, false),
    ).toBe("dialog");
    expect(
      settingsIntent(press_({ metaKey: true }), "Win32", false, false),
    ).toBe("ignore");
  });

  it("多一个修饰键、重复触发、输入法选字中，都不算", () => {
    const mac = press_({ metaKey: true });
    for (const extra of [
      { shiftKey: true },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
    ])
      expect(
        settingsIntent({ ...mac, ...extra }, "MacIntel", false, false),
      ).toBe("ignore");
  });

  it("别的键不是它，光一个逗号也不是它", () => {
    expect(
      settingsIntent(
        press_({ key: "k", metaKey: true }),
        "MacIntel",
        false,
        false,
      ),
    ).toBe("ignore");
    expect(settingsIntent(press_(), "MacIntel", false, false)).toBe("ignore");
  });

  it("已经有一层盖着：宽窗口让位，手机上照样开页面", () => {
    const mac = press_({ metaKey: true });
    expect(settingsIntent(mac, "MacIntel", true, false)).toBe("ignore");
    expect(settingsIntent(mac, "MacIntel", true, true)).toBe("page");
  });

  it("手机上开的是页面，宽窗口开的是弹窗", () => {
    const mac = press_({ metaKey: true });
    expect(settingsIntent(mac, "MacIntel", false, true)).toBe("page");
    expect(settingsIntent(mac, "MacIntel", false, false)).toBe("dialog");
  });
});

describe("⌘, 在哪都算", () => {
  it("在对话页按下：设置开在页面上", async () => {
    host();
    const event = await press();
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(true);
    expect(rail().length).toBeGreaterThan(0);
  });

  it("换一个页面再按也一样：监听挂在根上，没有页面在它之外", async () => {
    host();
    expect(open()).toBe(false);
    await press({}, "/tasks");
    expect(open()).toBe(true);
  });

  it("Windows 与 Linux 上是 Ctrl+,", async () => {
    host();
    onWindows();
    const event = await press({ windows: true });
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(true);
  });

  it("关掉再按，它还挂着：监听不属于那一次开启", async () => {
    host();
    await press();
    expect(open()).toBe(true);
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setSettings({ open: false, section: "appearance" }),
    );
    chord();
    await flush();
    expect(open()).toBe(true);
    // The section it was left on is the section drawn, not the one that ships by default.
    expect(rail().join("")).toContain(highlighted());
  });

  it("光一个逗号不归它管：没开，逗号照打进正在写的框里", async () => {
    host();
    await start();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const typed = new KeyboardEvent("keydown", {
      key: ",",
      bubbles: true,
      cancelable: true,
    });
    act(() => field.dispatchEvent(typed));
    expect(typed.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("⌘ 配的是别的键：不响应", async () => {
    host();
    const event = await press({ key: "k" });
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("多按了一个修饰键：⌘⇧, 与 ⌘⌥, 都不算", async () => {
    host();
    await start();
    for (const extra of [{ shiftKey: true }, { altKey: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: ",",
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      act(() => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(open()).toBe(false);
    }
  });

  it("没有 ⌘ 的机器不认 ⌘,，只认 Ctrl+,", async () => {
    host();
    onWindows();
    await press({ windows: true });
    expect(open()).toBe(true);
    await act(async () =>
      useWorkspaceStore
        .getState()
        .setSettings({ open: false, section: "agents" }),
    );
    const wrong = new KeyboardEvent("keydown", {
      key: ",",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(wrong));
    expect(open()).toBe(false);
  });

  it("按住不放重复触发，只算一次", async () => {
    host();
    await start();
    chord({ repeat: true });
    await flush();
    expect(open()).toBe(false);
  });

  it("输入法还在选字：这个键是给输入法的", async () => {
    host();
    const event = await press({ isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("焦点在输入框里照样开，preventDefault 就是逗号不进框的原因", async () => {
    host();
    await start();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    // The key comes from the field, as it does when you are mid-sentence: the command still owns
    // it, and `defaultPrevented` is what stops the character reaching the value.
    const event = new KeyboardEvent("keydown", {
      key: ",",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => field.dispatchEvent(event));
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(true);
  });
});

describe("已经有一层盖着的时候", () => {
  it("智能体编辑器开着：不叠第二层，那个窗口正拿着键盘", async () => {
    host();
    await start();
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: "a1" });
    await flush();
    expect(dialogs()).toBe(1);
    const event = chord();
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
    expect(dialogs()).toBe(1);
  });

  it("新建对话开着：一样不叠", async () => {
    host();
    await start();
    useWorkspaceStore.getState().setNewConversation({ open: true });
    await flush();
    const event = chord();
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
    expect(dialogs()).toBe(1);
  });
});

describe("手机上没有弹窗", () => {
  it("按下去的是 /settings 那一页，弹窗没开", async () => {
    host();
    phone = true;
    const event = await press();
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(false);
    expect(dialogs()).toBe(0);
  });

  it("盖着的那一层关掉：返回回到按下这一键的那一屏", async () => {
    host();
    phone = true;
    await start();
    useWorkspaceStore.getState().setNewConversation({ open: true });
    await flush();
    chord();
    await flush();
    expect(useWorkspaceStore.getState().newConversation.open).toBe(false);
  });

  it("手机上输入法选字中，同样不抢", async () => {
    host();
    phone = true;
    const router = await start();
    chord({ isComposing: true });
    await flush();
    expect(router.state.location.pathname).toBe("/");
  });
});
