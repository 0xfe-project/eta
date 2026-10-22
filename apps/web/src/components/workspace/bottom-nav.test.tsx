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

/** Radix opens a menu on pointer down. */
async function openPanel() {
  await act(async () => {
    plus().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label,
  );

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  useWorkspaceStore.setState({ newConversation: { open: false } });
  state.pathname = "/";
});

describe("手机底部栏", () => {
  it("has four destinations with the plus holding the middle cell", async () => {
    const container = await render();
    expect(links(container)).toEqual(["/", "/tasks", "/routines", "/settings"]);
    // Four destinations, five cells: the solid square sits between the two pairs.
    const cells = container.querySelector("nav > div")!.children;
    expect(cells).toHaveLength(5);
    expect(cells[2].contains(plus())).toBe(true);
  });

  it("the plus is a hit target of its own, not a mode of one of the tabs", async () => {
    await render();
    expect(plus().getAttribute("aria-label")).toBe("新建");
    expect(plus().className).toContain("size-[44px]");
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
    await act(async () => item("新建对话")!.click());
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
    await act(async () => item("新建群")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
