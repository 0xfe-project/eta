import { timingSafeEqual } from "node:crypto";
import type { NativeHandlers } from "../../../eta-server/src/server.ts";

/** Window-local capabilities; this listener never opens sessions or owns the backend. */
export function startNativeBridge(native: NativeHandlers, appVersion: string) {
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const origin = request.headers.get("origin");
			if (origin !== null && !["null", "views://eta", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"].includes(origin))
				return new Response("origin_denied", { status: 403 });
			const headers = {
				"access-control-allow-origin": origin ?? "null",
				"access-control-allow-headers": "content-type, authorization",
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"cache-control": "no-store",
				"vary": "Origin",
			};
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
			const supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
			const expected = Buffer.from(token);
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				return new Response("authentication_failed", { status: 401, headers });
			const path = new URL(request.url).pathname;
			const json = (body: unknown) => Response.json(body, { headers });
			if (path === "/api/native/info" && request.method === "GET")
				return json({ isDesktop: true, platform: process.platform, appVersion });
			if (request.method !== "POST") return new Response("not_found", { status: 404, headers });
			try {
				if (path === "/api/native/folder-dialog") return json({ path: await native.folderDialog(await request.json()) });
				if (path === "/api/native/save-file") return json({ path: await native.saveFile(await request.json()) });
				if (path === "/api/native/open-external") {
					native.openExternal(await request.json());
					return new Response(null, { status: 202, headers });
				}
				if (path === "/api/native/context-menu") {
					native.contextMenu(await request.json());
					return new Response(null, { status: 202, headers });
				}
				if (path === "/api/native/window-action") {
					if (native.windowAction === undefined) return new Response("not_found", { status: 404, headers });
					native.windowAction(await request.json());
					return new Response(null, { status: 202, headers });
				}
			} catch { return new Response("native_request_failed", { status: 400, headers }); }
			return new Response("not_found", { status: 404, headers });
		},
	});
	return { apiBase: `http://127.0.0.1:${server.port}`, token, close: () => { server.stop(true); } };
}
