import type { RouterContext } from "@/lib/query-client";
import {
  createRootRouteWithContext,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RootDocument } from "@/pages/root-document";

export const Route = createRootRouteWithContext<RouterContext>()({
  // Old links worked from any page (the settings dialog) or from /settings (the page).
  // Redirect before either renders, and replace the stale URL instead of adding a history stop.
  beforeLoad: ({ location: { pathname, searchStr } }) => {
    const search = new URLSearchParams(searchStr);
    const dialog = search.get("settings");
    const section =
      pathname === "/settings" || pathname === "/settings/"
        ? search.get("section")
        : null;
    const legacy =
      dialog === "plugins" || dialog === "skills" ? dialog : section;
    if (legacy === "plugins" || legacy === "skills") {
      throw redirect({
        to: legacy === "skills" ? "/plugins/skills" : "/plugins",
        search: {},
        replace: true,
      });
    }
  },
  // The page goes in as children: the shared chrome — the providers, the window's buttons, the
  // chord that opens settings — belongs to the window, and no page gets to mount it twice or
  // leave it out.
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
});
