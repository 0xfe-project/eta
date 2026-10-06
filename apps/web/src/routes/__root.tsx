import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { AppProviders } from "@/components/providers";
import type { RouterContext } from "@/lib/query-client";
import stylesheet from "@/styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AXP" },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  component: Root,
});

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppProviders>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-background focus:p-3 focus:text-foreground"
          >
            Skip to content
          </a>
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
