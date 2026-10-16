// Production server (Bun): built SPA assets plus /version.
// /api is routed by the edge gateway (apps/gateway), not here.
import { join, resolve, sep } from "node:path";
import process from "node:process";
import { handleWebApi } from "./src/server/http.ts";
import { browserSentryMeta } from "./src/server/sentry-meta.ts";
import {
  log,
  setupTelemetry,
  shutdownTelemetry,
} from "./src/server/telemetry.ts";

const distDir = join(import.meta.dir, "dist");
const distPrefix = distDir.endsWith(sep) ? distDir : distDir + sep;

function fileInDist(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const filePath = resolve(distDir, `.${decoded}`);
  if (filePath !== distDir && !filePath.startsWith(distPrefix)) return null;
  return Bun.file(filePath);
}

async function respond(request, buildId, shell) {
  const handled = await handleWebApi(request, buildId);
  if (handled) return handled;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const { pathname } = new URL(request.url);
  if (/\.[^/]+$/.test(pathname)) {
    const file = fileInDist(pathname);
    if (file && (await file.exists())) {
      const headers = pathname.startsWith("/assets/")
        ? { "Cache-Control": "public, max-age=31536000, immutable" }
        : {};
      return new Response(file, { headers });
    }
    return new Response(null, { status: 404 });
  }
  return new Response(shell, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function start() {
  setupTelemetry("web");
  const buildId = (await Bun.file(join(distDir, "BUILD")).text()).trim();
  // The SPA shell, with the browser's Sentry settings.
  const shell = (await Bun.file(join(distDir, "index.html")).text()).replace(
    "</head>",
    `${browserSentryMeta()}</head>`,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT || 24003),
    fetch: (request) => respond(request, buildId, shell),
  });
  log.info("web listening", { url: server.url.href });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      await server.stop();
      await shutdownTelemetry();
      process.exit(0);
    });
  }
}

start();
