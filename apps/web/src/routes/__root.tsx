import type { RouterContext } from "@/lib/query-client";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { AppProviders } from "@/components/providers";
import { WorkspaceProvider } from "@/components/workspace/workspace-state";
import stylesheet from "@/styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AXP" },
      { name: "theme-color", content: "#ffffff" },
      { name: "apple-mobile-web-app-title", content: "AXP" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      // Production sits behind Cloudflare Access, so the manifest request
      // must carry cookies.
      {
        rel: "manifest",
        href: "/manifest.webmanifest",
        crossOrigin: "use-credentials",
      },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: Root,
});

function Root() {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppProviders>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-background focus:p-3 focus:text-foreground"
          >
            跳转到内容
          </a>
          <WorkspaceProvider>
            <Outlet />
          </WorkspaceProvider>
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
