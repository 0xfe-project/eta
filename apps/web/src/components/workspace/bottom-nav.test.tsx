import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { agentView, productHost, projectView } from "@/test-product";
import { BottomNav } from "./app-shell";
import { useWorkspaceStore } from "./workspace-store";

const state = rstest.hoisted(() => ({ pathname: "/" }));
rstest.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a data-to={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
  useNavigate: () => () => undefined,
}));
rstest.mock("./use-attention", () => ({
  useAttention: () => ({ total: 2 }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BottomNav />
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

const links = (container: HTMLElement) =>
  [...container.querySelectorAll("a")].map((a) => a.getAttribute("data-to"));

/** The plus: the one button in the bar that is not a link. */
const plus = () => document.querySelector<HTMLElement>("nav button")!;

/** The plus asks which of the two it is in a dialog, not in a menu: a thumb needs a big target. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

async function openPanel() {
  await act(async () => {
    plus().click();
    await settled();
  });
}

/** One of the two things one starts from the phone. */
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent === label,
  );

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  useWorkspaceStore.setState({ newConversation: { open: false } });
  state.pathname = "/";
});

describe("手机底部栏", () => {
  it("has three destinations with the plus between them", async () => {
    const container = await render();
    expect(links(container)).toEqual(["/", "/tasks", "/settings"]);
    // Three destinations, four cells: the solid square sits between the two
    // sides. 定时 is off in this build, so it has no cell of its own.
    const cells = container.querySelector("nav > div > div.grid")!.children;
    expect(cells).toHaveLength(4);
    expect(cells[2].contains(plus())).toBe(true);
  });

  it("the plus is a hit target of its own, not a mode of one of the tabs", async () => {
    await render();
    expect(plus().getAttribute("aria-label")).toBe("新建");
    expect(plus().className).toContain("size-[68px]");
  });

  it("offers the two things one starts from the phone", async () => {
    productHost({
      agents: [agentView({ id: "a1", name: "乐子人" })],
      projects: [projectView({ id: "p1", name: "eta", path: "/work/eta" })],
    }).install();
    await render();
    await openPanel();
    expect(item("新建对话")).toBeDefined();
    expect(item("新建群")).toBeDefined();
  });

  it("新建对话 opens the conversation dialog", async () => {
    await render();
    await openPanel();
    await act(async () => {
      item("新建对话")!.click();
      // The next dialog opens a frame later: opening it in the same frame leaves the first
      // one's overlay holding the pointer.
      await settled();
    });
    expect(useWorkspaceStore.getState().newConversation.open).toBe(true);
  });

  it("新建群 opens the group dialog", async () => {
    const fake = productHost({
      agents: [agentView({ id: "a1", name: "乐子人" })],
      projects: [projectView({ id: "p1", name: "eta", path: "/work/eta" })],
    });
    fake.install();
    fake.hello();
    await render();
    await openPanel();
    await act(async () => {
      item("新建群")!.click();
      await settled();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
