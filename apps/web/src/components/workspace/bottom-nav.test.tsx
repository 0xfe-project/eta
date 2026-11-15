import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { cleanup, mount } from "@/test-render";
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

async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  return (await mount(<BottomNav />, client)).container;
}

const links = (container: HTMLElement) =>
  [...container.querySelectorAll("a")].map((a) => a.getAttribute("data-to"));

/** The plus: the one button in the bar that is not a link. */
const plus = () => document.querySelector<HTMLElement>("nav button")!;

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useWorkspaceStore.setState({ newConversation: { open: false } });
  state.pathname = "/";
});

describe("手机底部栏", () => {
  it("has four destinations with the plus between them", async () => {
    const container = await render();
    expect(links(container)).toEqual(["/", "/tasks", "/email", "/settings"]);
    // Four destinations and the solid square between tasks/email and settings. 定时 is off in
    // this build, so it has no cell of its own.
    const anchors = [...container.querySelectorAll("a")];
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(anchors[2]!, plus())).toBe(true);
    expect(follows(plus(), anchors[3]!)).toBe(true);
  });

  it("the plus is a hit target of its own, not a mode of one of the tabs", async () => {
    await render();
    expect(plus().getAttribute("aria-label")).toBe("新建");
    expect(plus().closest("a")).toBeNull();
  });

  it("opens the one dialog that starts anything, with nothing to choose first", async () => {
    await render();
    await act(async () => plus().click());
    expect(useWorkspaceStore.getState().newConversation.open).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
