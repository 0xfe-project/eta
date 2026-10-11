import process from "node:process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Long-lived vendor chunks for the browser, so the entry stays small and
// dependency upgrades do not invalidate app code (and vice versa).
const vendorChunks = {
  react: ["react", "react-dom", "scheduler"],
  // use-sync-external-store is a CommonJS dependency of @tanstack/react-store;
  // left in the entry chunk it forms an import cycle with vendor-tanstack,
  // which then calls it before the entry has initialised it.
  tanstack: [
    "@tanstack",
    "seroval",
    "seroval-plugins",
    "use-sync-external-store",
  ],
  zod: ["zod"],
};

function vendorGroups() {
  return Object.entries(vendorChunks).map(([name, packages]) => ({
    name: `vendor-${name}`,
    test: new RegExp(`[\\/]node_modules[\\/](${packages.join("|")})[\\/]`),
  }));
}

// One per build, shared by its browser and server code (routes/version.ts).
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
      tanstackStart({ client: { entry: "./client.tsx" } }),
      react(),
    ],
    environments: {
      client: {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                // Only the matched packages; by default a group also takes
                // their dependencies, and TanStack Start's client entry
                // imports the whole app.
                includeDependenciesRecursively: false,
                groups: vendorGroups(),
              },
            },
          },
        },
      },
    },
    server: {
      port: Number(env.AXP_WEB_PORT || 3000),
      strictPort: true,
      // /api is served through the edge gateway (apps/gateway), which is the
      // address to open in development as well.
    },
  };
});
