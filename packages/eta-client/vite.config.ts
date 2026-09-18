import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import solidGrab from "solid-grab/vite";
import { createLogger } from "vite";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// The dev proxy writes to the page's socket after the page (or the watched
// server) has already dropped it: a dead-socket write in dev is noise, not an
// error, and the noise buries everything else in the terminal.
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (message, options) => {
	const code = (options?.error as { code?: string } | undefined)?.code;
	if (message.includes("proxy socket error") && (code === "EPIPE" || code === "ECONNRESET")) return;
	logError(message, options);
};

const directory = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = process.env.ETA_SERVER_URL ?? "http://127.0.0.1:3000";

/**
 * The backend now requires its loopback credential on every route, including the page
 * it serves itself. This page is served by vite instead, so the proxy hands the
 * credential over — read from the run file the backend publishes, cached for a second
 * because every API call and every socket handshake goes through here.
 */
const runFile = process.env.ETA_RUN_FILE ?? path.join(homedir(), ".eta", "run.json");
let cached: { at: number; token?: string } = { at: 0 };
function devToken(): string | undefined {
	const now = Date.now();
	if (now - cached.at < 1000) return cached.token;
	let token: string | undefined;
	try {
		const parsed = JSON.parse(readFileSync(runFile, "utf8")) as { token?: unknown };
		if (typeof parsed.token === "string") token = parsed.token;
	} catch {
		/* no service running: the backend is open (ETA_SERVICE=off) or not up yet */
	}
	cached = { at: now, token };
	return token;
}

function withCredential(options: { target: string; ws?: boolean }): Record<string, unknown> {
	return {
		target: options.target,
		changeOrigin: true,
		...(options.ws === true ? { ws: true } : {}),
		configure: (proxy: unknown): void => {
			const server = proxy as {
				on(event: string, handler: (request: { setHeader(name: string, value: string): void }) => void): void;
			};
			const attach = (request: { setHeader(name: string, value: string): void }): void => {
				const token = devToken();
				if (token !== undefined) request.setHeader("authorization", `Bearer ${token}`);
			};
			server.on("proxyReq", attach);
			server.on("proxyReqWs", attach);
		},
	};
}

// `logger` is an inline-config option, not a UserConfig one: it reaches the dev
// server by sitting on the exported object, next to what defineConfig checked.
export default Object.assign(defineConfig({
	resolve: { alias: { "@": path.resolve(directory, "src") } },
	plugins: [
		// Maps a grabbed element back to its source line. Solid compiles components away, so the
		// mapping is build-time attributes rather than a runtime tree — hence before solid(), which
		// is what erases the JSX. `apply: "serve"`, and projectRoot lifts paths to the repo root so
		// the copied context says packages/eta-client/src/…, not ../src/…
		solidGrab({ projectRoot: "../.." }),
		solid({ hot: process.env.VITEST === undefined }),
		tailwindcss(),
	],
	server: {
		port: 5173,
		strictPort: true,
		/* Nothing a dev server hands out is worth caching — the whole point is that the bytes
		   change under you. A response with no directive at all is exactly what WebKit will
		   reuse on its own, which is how an edited stylesheet goes on painting last hour's rules
		   in the desktop webview while curl and Chrome both show the new ones. */
		headers: { "Cache-Control": "no-store" },
		proxy: {
			"/api": withCredential({ target: serverUrl }),
			"/ws": withCredential({ target: serverUrl.replace(/^http/, "ws"), ws: true }),
			"/term": withCredential({ target: serverUrl.replace(/^http/, "ws"), ws: true }),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["test/setup.ts"],
		include: ["test/**/*.test.{ts,tsx}"],
		// Each DOM worker loads the full rendering/tooling graph. Bound concurrent
		// transforms so a cold run on a laptop doesn't consume the assertion timeout.
		maxWorkers: 2,
	},
}), { logger });
