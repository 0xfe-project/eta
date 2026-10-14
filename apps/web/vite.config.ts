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
const build = (process.env.AXP_WEB_BUILD ||= Date.now().toString(36));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    define: { __AXP_BUILD__: JSON.stringify(build) },
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
        name: "axp-web-api",
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
      port: Number(env.AXP_WEB_PORT || 3000),
      strictPort: true,
      // /api is served through the edge gateway (apps/gateway), which is the
      // address to open in development as well.
    },
    preview: {
      port: Number(env.AXP_WEB_PORT || 3000),
      strictPort: true,
    },
  };
});
