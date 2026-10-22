import { describe, expect, it } from "@rstest/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Route as unknownPath } from "@/routes/$";

// The route the file defines, mounted beside the pages that remain.
async function open(path: string) {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({ getParentRoute: () => root, path: "tasks" }),
      createRoute({ getParentRoute: () => root, path: "routines" }),
      createRoute({
        getParentRoute: () => root,
        path: "$",
        beforeLoad: unknownPath.options.beforeLoad as () => void,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return router.state.location.pathname;
}

describe("removed pages", () => {
  it.each([
    // The old workspace prefix, which tasks and routines have left.
    "/workspace/tasks",
    "/workspace/routines",
    "/workspace/inbox",
    "/workspace/memory",
    // A path that never was one.
    "/nope",
  ])("%s redirects to the conversation list", async (path) => {
    expect(await open(path)).toBe("/");
  });

  it("keeps the pages that remain", async () => {
    expect(await open("/tasks")).toBe("/tasks");
    expect(await open("/routines")).toBe("/routines");
  });
});
