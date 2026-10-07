import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [
      tailwindcss(),
      tanstackStart({ client: { entry: "./client.tsx" } }),
      react(),
    ],
    server: {
      port: Number(env.AXP_WEB_PORT || 3000),
      strictPort: true,
      // /api is served through the edge gateway (apps/gateway), which is the
      // address to open in development as well.
    },
  };
});
