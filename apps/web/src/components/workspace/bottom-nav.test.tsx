import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
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

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
  useWorkspaceStore.setState({ newConversation: { open: false } });
  state.pathname = "/";
});

describe("手机底部栏", () => {
  it("has four destinations with the plus between them", async () => {
    const container = await render();
    expect(links(container)).toEqual(["/", "/tasks", "/email", "/settings"]);
    // Four destinations, five cells: the solid square sits between tasks/email
    // and settings. 定时 is off in this build, so it has no cell of its own.
    const cells = container.querySelector("nav > div > div.grid")!.children;
    expect(cells).toHaveLength(5);
    expect(cells[3].contains(plus())).toBe(true);
  });

  it("the plus is a hit target of its own, not a mode of one of the tabs", async () => {
    await render();
    expect(plus().getAttribute("aria-label")).toBe("新建");
    expect(plus().className).toContain("size-[68px]");
  });

  it("opens the one dialog that starts anything, with nothing to choose first", async () => {
    await render();
    await act(async () => plus().click());
    expect(useWorkspaceStore.getState().newConversation.open).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
