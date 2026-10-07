// Production server (Bun): built client assets plus the TanStack Start SSR
// handler. /api is routed by the edge gateway (apps/gateway), not here.
import { join, normalize } from "node:path";
import process from "node:process";
import handler from "./dist/server/server.js";

const clientDir = join(import.meta.dir, "dist/client");

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT || 3000),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/up") return new Response("ok");
    // Only paths with a file extension can be static assets.
    if (/\.[^/]+$/.test(pathname)) {
      const file = Bun.file(
        join(clientDir, normalize(decodeURIComponent(pathname))),
      );
      if (await file.exists()) {
        const headers = pathname.startsWith("/assets/")
          ? { "Cache-Control": "public, max-age=31536000, immutable" }
          : {};
        return new Response(file, { headers });
      }
    }
    return handler.fetch(request);
  },
});

console.log(`Web listening on ${server.url}`);
