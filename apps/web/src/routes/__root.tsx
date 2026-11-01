import type { RouterContext } from "@/lib/query-client";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { RootDocument } from "@/pages/root-document";

export const Route = createRootRouteWithContext<RouterContext>()({
  // The page goes in as children: the shared chrome — the providers, the window's buttons, the
  // chord that opens settings — belongs to the window, and no page gets to mount it twice or
  // leave it out.
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
});
