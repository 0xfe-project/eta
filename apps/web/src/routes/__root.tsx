import type { RouterContext } from "@/lib/query-client";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { RootDocument } from "@/pages/root-document";
import stylesheet from "@/styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AXP" },
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
  component: RootDocument,
});
