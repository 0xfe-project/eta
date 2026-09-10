import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

const directory = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = process.env.ETA_SERVER_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
	resolve: { alias: { "@": path.resolve(directory, "src") } },
	plugins: [solid(), tailwindcss()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": { target: serverUrl, changeOrigin: true },
			"/ws": { target: serverUrl.replace(/^http/, "ws"), ws: true },
			"/term": { target: serverUrl.replace(/^http/, "ws"), ws: true },
		},
	},
	test: { environment: "jsdom", setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
});
