import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { webApiMiddleware } from "./src/server/http.ts";

// Long-lived vendor chunks for the browser, so the entry stays small and
// dependency upgrades do not invalidate app code (and vice versa).
const vendorChunks = {
  react: ["react", "react-dom", "scheduler"],
  tanstack: ["@tanstack", "use-sync-external-store"],
  zod: ["zod"],
};

function vendorGroups() {
  return Object.entries(vendorChunks).map(([name, packages]) => ({
    name: `vendor-${name}`,
    test: new RegExp(`[\\/]node_modules[\\/](${packages.join("|")})[\\/]`),
  }));
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// One per build, shared by the browser bundle and GET /version.
// The config is evaluated once per environment, so it is kept in the process.
const build = (process.env.ETA_WEB_BUILD ||= Date.now().toString(36));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    define: { __ETA_BUILD__: JSON.stringify(build) },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [
      tailwindcss(),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        quoteStyle: "double",
      }),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      {
        name: "eta-web-api",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "BUILD", source: build });
        },
        configureServer(server) {
          server.middlewares.use(webApiMiddleware(() => build));
        },
        configurePreviewServer(server) {
          const id = readFileSync(
            fileURLToPath(new URL("./dist/BUILD", import.meta.url)),
            "utf8",
          ).trim();
          server.middlewares.use(webApiMiddleware(() => id));
        },
      },
    ],
    build: {
      // Public, so React Grab (圈选元素, lib/element-picker.ts) can map the
      // production bundle back to source files and component names.
      sourcemap: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: vendorGroups(),
          },
          // apps/web/src/… rather than ../../../src/…, as copied by React
          // Grab.
          sourcemapPathTransform: (source, map) =>
            relative(repoRoot, resolve(dirname(map), source)),
          // Component names survive minification, for the same copy.
          keepNames: true,
        },
      },
    },
    server: {
      // Loopback by name, so the address vite prints is the address that answers.
      host: env.ETA_WEB_HOST || "127.0.0.1",
      port: Number(env.ETA_WEB_PORT || 3000),
      strictPort: true,
      // Development is two processes: this one owns the page and its HMR, the host
      // owns the data. The page talks to the host over exactly one WebSocket, at
      // /ws, so that is all that crosses over and nothing in the SPA needs to
      // know a second port exists. The browser still sends vite's origin, which
      // the host is started to allow (--allow-origin, see the root dev script).
      //
      // `/up` and `/version` stay here on purpose. They answer "is this page
      // alive" and "which build of this page am I", so the server that serves
      // the page answers them: vite here, the host in production, and both give
      // a build id the tab can compare with its own (src/lib/update.ts).
      // Forwarding them would hand the browser the host's id in one deployment
      // and the bundle's in another, which is how every tab ends up claiming an
      // update is waiting.
      proxy: {
        "/upgrade": env.ETA_HOST_ORIGIN || "http://127.0.0.1:8787",
        "/ws": {
          target: env.ETA_HOST_ORIGIN || "http://127.0.0.1:8787",
          ws: true,
          changeOrigin: false,
        },
      },
    },
    preview: {
      port: Number(env.ETA_WEB_PORT || 3000),
      strictPort: true,
    },
  };
});
