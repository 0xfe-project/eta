import { createRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/app-skeleton";
import { createQueryClient } from "@/lib/query-client";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const queryClient = createQueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    // Not on the chat: every conversation is one more location of "/", in the same scrollers, and
    // the router would write the last conversation's offsets into the next one.
    scrollRestoration: ({ location }) => location.pathname !== "/",
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // A page whose code is still downloading shows its outline instead of a blank screen. The
    // routes that draw their own shell ("/" and "/_app") bring a whole-window one; the pages under
    // the shell get this, so the real sidebar stays. 200ms before it shows keeps a fast chunk from
    // flashing it, and once shown it stays 300ms so it does not flicker away.
    defaultPendingComponent: PageSkeleton,
    defaultPendingMs: 200,
    defaultPendingMinMs: 300,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
