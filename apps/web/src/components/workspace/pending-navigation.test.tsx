import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { surfaceHost } from "@/test-inbox";
import { routineInfo, routineSections, taskDetail } from "@/test-product";
import { PendingList } from "./attention";
import { useOpenGroup } from "./use-groups";
import { useShowLinkedView } from "./workspace-search";
import { useWorkspaceStore } from "./workspace-store";

// The pending list opens what it lists in the mode it is shown in: beside
// the chat, the side panel's tabs; on its own page, that page.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(ui: () => React.ReactNode, path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  surfaceHost({
    tasks: [
      {
        task: taskDetail({
          id: "t1",
          number: 1,
          title: "任务1",
          status: "in_review",
        }),
      },
    ],
    routines: [
      routineSections(
        routineInfo({ id: "r1", name: "日报", unseenReports: 1 }),
      ),
    ],
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <NuqsAdapter>{ui()}</NuqsAdapter>,
    }),
    history,
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return { container, router, history };
}

function ShowLinkedView() {
  useShowLinkedView();
  return null;
}

/** The phone's way in: a row that opens a conversation, beside the same URL watcher the app has. */
function OpenRow() {
  const open = useOpenGroup();
  useShowLinkedView();
  return (
    <button type="button" onClick={() => open("g1")}>
      装配
    </button>
  );
}

const links = (container: HTMLElement) =>
  [...container.querySelectorAll("li a")].map((a) => a.getAttribute("href"));

describe("pending navigation", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ mobilePanel: "chat" });
    surfaceHost();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    setWire(undefined);
  });

  it("opens a task beside the chat, a routine on its own page", async () => {
    // The panel has a tasks tab; routines left the panel, so useSectionLink sends that row to the
    // page even from the chat.
    const { container } = await mount(() => <PendingList />, "/?view=inbox");
    expect(links(container)).toEqual([
      "/?view=tasks&task=t1",
      "/routines?routine=r1",
    ]);
  });

  it("opens them on their own pages", async () => {
    const { container } = await mount(() => <PendingList />, "/tasks");
    expect(links(container)).toEqual([
      "/tasks?task=t1",
      "/routines?routine=r1",
    ]);
  });

  it("stays beside the chat when a row is followed", async () => {
    const { container, router } = await mount(
      () => <PendingList />,
      "/?view=inbox",
    );
    await act(async () => {
      container.querySelector<HTMLAnchorElement>("li a")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toEqual({ view: "tasks", task: "t1" });
  });

  it("shows the panel on narrow screens when the URL opens a tab", async () => {
    // A reload or a link straight to the tab.
    await mount(() => <ShowLinkedView />, "/?view=inbox");
    expect(useWorkspaceStore.getState().mobilePanel).toBe("workspace");
  });

  it("keeps the chat on narrow screens when the URL names no tab", async () => {
    const { history } = await mount(() => <ShowLinkedView />, "/");
    expect(useWorkspaceStore.getState().mobilePanel).toBe("chat");
    // Back and forward to a tab show the panel again.
    await act(async () => {
      history.push("/?view=inbox");
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(useWorkspaceStore.getState().mobilePanel).toBe("workspace");
  });

  it("a conversation row opens the chat, even from inside the panel", async () => {
    // The panel is on screen, the URL asked for its inbox tab; then the thumb goes to a row. The
    // row asks for a conversation and nothing else, so the panel has nothing to stay open for —
    // it used to, because every open also carried `view: "context"`, which the URL watcher above
    // reads as "open my tab", and the chat you just tapped arrived behind the panel.
    const { container, router } = await mount(
      () => <OpenRow />,
      "/?group=g9&view=inbox",
    );
    expect(useWorkspaceStore.getState().mobilePanel).toBe("workspace");
    await act(async () => {
      container.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(router.state.location.search).toEqual({ group: "g1" });
    expect(useWorkspaceStore.getState().mobilePanel).toBe("chat");
  });
});
