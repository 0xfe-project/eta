import { describe, expect, it } from "@rstest/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Route as unknownWorkspacePage } from "@/routes/workspace/$";

// The route the file defines, mounted beside the two pages that remain.
async function open(path: string) {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({ getParentRoute: () => root, path: "workspace/tasks" }),
      createRoute({ getParentRoute: () => root, path: "workspace/routines" }),
      createRoute({
        getParentRoute: () => root,
        path: "workspace/$",
        beforeLoad: unknownWorkspacePage.options.beforeLoad as () => void,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return router.state.location.pathname;
}

describe("removed pages", () => {
  it.each(["/workspace/inbox", "/workspace/memory", "/workspace/more"])(
    "%s redirects to the conversation list",
    async (path) => {
      expect(await open(path)).toBe("/");
    },
  );

  it("keeps tasks and routines", async () => {
    expect(await open("/workspace/tasks")).toBe("/workspace/tasks");
    expect(await open("/workspace/routines")).toBe("/workspace/routines");
  });
});
