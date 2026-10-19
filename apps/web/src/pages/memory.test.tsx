import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { surfaceHost } from "@/test-inbox";
import { agentView } from "@/test-product";
import { flush } from "@/test-render";
import { MemoryPage } from "./memory";
import { More } from "./more";

const mounted: (() => void)[] = [];

async function open(path: string) {
  const root = createRootRoute({
    component: () => (
      <NuqsAdapter>
        <Outlet />
      </NuqsAdapter>
    ),
  });
  const pages = [
    "/workspace/memory",
    "/workspace/more",
    "/workspace/inbox",
    "/workspace/routines",
  ].map((to) =>
    createRoute({
      getParentRoute: () => root,
      path: to,
      component:
        to === "/workspace/memory"
          ? MemoryPage
          : to === "/workspace/more"
            ? More
            : () => <p>elsewhere</p>,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren(pages),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  await flush(10);
  mounted.push(() => {
    reactRoot.unmount();
    container.remove();
  });
  return { container, router };
}

afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
});

describe("the memory page", () => {
  it("is a page and a navigation entry when the host has a memory sidecar", async () => {
    const host = surfaceHost({
      memory: true,
      agents: [agentView({ id: "a", name: "助手" })],
    });
    host.handle("memory.list", () => ({ memories: [] }));
    const page = await open("/workspace/memory");
    expect(page.router.state.location.pathname).toBe("/workspace/memory");
    expect(page.container.textContent).toContain("助手");
    setWire(undefined);

    surfaceHost({ memory: true });
    const more = await open("/workspace/more");
    expect(
      more.container.querySelector('a[href="/workspace/memory"]'),
    ).not.toBeNull();
  });

  it("is neither without one: the address goes to the inbox and the entry is gone", async () => {
    surfaceHost();
    const page = await open("/workspace/memory");
    expect(page.router.state.location.pathname).toBe("/workspace/inbox");
    setWire(undefined);

    surfaceHost();
    const more = await open("/workspace/more");
    expect(
      more.container.querySelector('a[href="/workspace/memory"]'),
    ).toBeNull();
    expect(
      more.container.querySelector('a[href="/workspace/routines"]'),
    ).not.toBeNull();
  });
});
