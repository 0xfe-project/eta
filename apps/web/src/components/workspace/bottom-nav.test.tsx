import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BottomNav } from "./app-shell";

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

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  state.pathname = "/";
});

describe("手机底部栏", () => {
  it("has three tabs, each of them a page that exists", async () => {
    const container = await render();
    const targets = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("data-to"),
    );
    expect(targets).toEqual(["/", "/workspace/tasks", "/workspace/more"]);
  });

  it("lights the tab a detail page belongs to, not just an exact match", async () => {
    state.pathname = "/workspace/routines";
    const container = await render();
    const lit = [...container.querySelectorAll("a")].find((a) =>
      a.className.includes("bg-muted/50"),
    );
    // Routines has no tab of its own; it lives behind 更多.
    expect(lit?.getAttribute("data-to")).toBe("/workspace/more");
  });
});
