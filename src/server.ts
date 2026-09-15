/**
 * HTTP + WebSocket host for the eta front-end (GUI-PLAN v2 W0.2/W0.3/W0.6).
 * One bun process, core in-process; every browser tab is a thin observer of
 * the three channels. Static: serves the built eta-web SPA when present.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { encodeMessage, decodeClientMessage, type ClientMessage, type ServerMessage } from "./protocol.ts";
import { Host } from "./host.ts";
import { gitDiff, gitStatus, notGitStatus, type GitDiffKind } from "./git.ts";
import { listPersonaSummaries, watchPersonaDirs } from "./personas.ts";
import { UnknownPersonaError } from "./agent.ts";
import { TermRegistry } from "./terminal.ts";
import { initializeNetwork } from "./network.ts";
import { etaConfigPath, loadEtaConfig } from "./config.ts";
import { ProviderConfigError } from "./providers.ts";

export interface NativeHandlers {
	folderDialog(input: { startingFolder?: string }): Promise<string | null>;
	saveFile(input: { content: string; filename: string }): Promise<string | null>;
	/** Returns immediately; the click result is reported by the shell via push(). */
	contextMenu(input: { items: unknown[] }): void;
}

export interface EtaServerOptions {
	port?: number;
	hostname?: string;
	cwd?: string;
	webDist?: string;
	configPath?: string;
	dataDir?: string;
	/** Loop wake cadence, in ms; see HostOptions. */
	heartbeatMs?: number;
	/** Present only when embedded in a desktop shell; enables /api/native/*. */
	native?: NativeHandlers;
	reusePort?: boolean;
	platform?: string;
	appVersion?: string;
	/** Desktop credential for sensitive settings APIs from the opaque views:// origin. */
	settingsToken?: string;
}

export interface EtaServer {
	host: Host;
	port: number;
	/** Broadcast a frame to every connected /ws socket. */
	push(message: ServerMessage): void;
	close(): void;
}

type Socket = ServerWebSocket<{ kind?: "ws" | "term"; socketId?: number; shell?: unknown; viewPatch?: boolean }>;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

export async function startServer(options: EtaServerOptions = {}): Promise<EtaServer> {
	const networkStatus = await initializeNetwork(loadEtaConfig(options.configPath ?? etaConfigPath)?.network);
	const host = new Host({
		...(options.configPath === undefined ? {} : { configPath: options.configPath }),
		...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
		...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
	});
	await host.restoreSessions();
	const cwd = options.cwd ?? process.cwd();
	const webDist = options.webDist ?? resolve(import.meta.dir, "../../eta-client/dist");
	// The desktop webview's origin is views://eta, so every /api answer is
	// cross-origin from the server's point of view: hand out a blanket allow.
	const CORS_HEADERS: Record<string, string> = {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "*",
		"access-control-allow-methods": "*",
	};
	const apiJson = (data: unknown, init: ResponseInit = {}): Response => {
		const headers = new Headers(init.headers);
		for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
		return Response.json(data, { status: init.status, headers });
	};
	const apiError = (message: string, status: number): Response => new Response(message, { status, headers: CORS_HEADERS });
	const sessionsDirty = new WeakMap<Socket, boolean>();

	const send = (socket: Socket, message: ServerMessage, payload?: string): void => {
		try {
			socket.send(payload ?? encodeMessage(message));
		} catch {
			/* socket already gone */
		}
	};

	const flushSessions = (socket: Socket): void => {
		if (sessionsDirty.get(socket) === true) return;
		sessionsDirty.set(socket, true);
		queueMicrotask(() => {
			if (sessionsDirty.get(socket) !== true) return;
			sessionsDirty.set(socket, false);
			send(socket, { type: "sessions", sessions: host.sidebar() });
		});
	};

	const sockets = new Set<Socket>();

	/**
	 * A patch frame is only cheaper than a whole one if the tab on the other end can
	 * fold it: a tab still running the previous bundle reads `frame.view.messages`
	 * out of a frame that has no `view`, and wedges. So patches wait until every
	 * connected client asked for one — in practice the moment every tab reloaded —
	 * and switch off again the second a stale tab appears.
	 */
	const syncPatchCapable = (): void => {
		host.setPatchCapable(sockets.size > 0 && [...sockets].every((socket) => socket.data.viewPatch === true));
	};

	const unsubscribe = host.subscribe((frame, payload) => {
		// The agent channel is per-token and the browser folds it into the view frame
		// and ignores this one (see eta-web's reduceEtaState) — forwarding it measured
		// about 1MB/s of JSON each tab parses straight into the bin. Whoever wants raw
		// harness events asks; the GUI does not.
		if ("channel" in frame && frame.channel === "agent") return;
		for (const socket of sockets) {
			send(socket, frame, payload);
			flushSessions(socket);
		}
	});

	const terms = new TermRegistry();
	watchPersonaDirs(process.cwd(), () => {
		for (const socket of sockets) send(socket, { type: "personas" });
	});
	const server = Bun.serve<{ kind?: "ws" | "term"; socketId?: number; shell?: unknown; viewPatch?: boolean }>({
		port: options.port ?? 3000,
		hostname: options.hostname ?? "0.0.0.0",
		// One writer per journal: with SO_REUSEPORT a second server happily binds the
		// same port, opens the same session directories, and appends to journals it never
		// read — which is how a tool result ends up committed twice. Fail the bind instead.
		reusePort: options.reusePort ?? false,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/api/providers" || url.pathname.startsWith("/api/providers/")) {
				const origin = request.headers.get("origin");
				const localDevOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"]);
				const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
				const desktopOrigin = origin === "null" || origin === "views://eta";
				const desktop = desktopOrigin && options.native !== undefined && !!options.settingsToken;
				const allowed = origin === null || origin === url.origin || (loopback && localDevOrigins.has(origin)) || desktop;
				if (!allowed) return Response.json({ error: "origin_denied" }, { status: 403 });
				const headers: Record<string, string> = {
					...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
					"access-control-allow-headers": "content-type, authorization",
					"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
					"cache-control": "no-store",
				};
				if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
				if (desktop && request.headers.get("authorization") !== `Bearer ${options.settingsToken}`) return Response.json({ error: "authentication_failed" }, { status: 401, headers });
				const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
				try {
					if (request.method === "GET" && url.pathname === "/api/providers/network") { const view = await host.providers.view(); return json({ revision: view.revision, network: view.network, runtime: networkStatus }); }
					if (request.method === "GET" && url.pathname === "/api/providers") return json(await host.providerView());
					if (!["POST", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
					if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_config" }, 415);
					const text = await request.text();
					if (text.length > 512_000) return json({ error: "invalid_config" }, 413);
					let body: unknown;
					try { body = JSON.parse(text); } catch { return json({ error: "invalid_config" }, 400); }
					if (request.method === "POST") {
						if (url.pathname === "/api/providers/codex/login") return json(host.providers.startCodexLogin(body));
						if (url.pathname === "/api/providers/codex/answer") return json(host.providers.answerCodexLogin(body));
						if (url.pathname === "/api/providers/codex/status") return json(host.providers.codexLogin.status(String((body as { id?: unknown })?.id ?? "")));
						if (url.pathname === "/api/providers/codex/cancel") { host.providers.codexLogin.cancel(String((body as { id?: unknown })?.id ?? "")); return json({ ok: true }); }
						if (url.pathname === "/api/providers/discover") return json(await host.providers.discover(body));
						if (url.pathname === "/api/providers/network") return json(await host.providers.setNetwork(body));
						if (url.pathname === "/api/providers/default") return json(await host.defaultProviderModel(body));
						if (url.pathname === "/api/providers") return json(await host.saveProvider(body));
					}
					if (request.method === "DELETE") {
						const id = decodeURIComponent(url.pathname.slice("/api/providers/".length));
						return json(await host.deleteProvider(id, (body as { revision?: unknown })?.revision));
					}
					return json({ error: "not_found" }, 404);
				} catch (error) {
					return error instanceof ProviderConfigError ? json({ error: error.code }, error.status) : json({ error: "save_failed" }, 500);
				}
			}
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
			if (url.pathname === "/ws") {
				if (
					srv.upgrade(request, {
						data: { kind: "ws", socketId: nextSocketId++, viewPatch: url.searchParams.has("viewPatch") },
					})
				)
					return;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/term") {
				if (srv.upgrade(request, { data: { kind: "term", socketId: nextSocketId++ } })) return;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/api/health") {
				return apiJson({ ok: true });
			}
			if (url.pathname === "/api/memory") {
				const memorySession = url.searchParams.get("session");
				const loader = memorySession === null ? undefined : host.memoryText(memorySession);
				if (loader === undefined) return apiJson({ text: "", files: [] });
				return apiJson(await loader);
			}
			if (url.pathname === "/api/personas") {
				return apiJson(await listPersonaSummaries(cwd));
			}
			if (url.pathname === "/api/files") {
				const session = url.searchParams.get("session");
				const root = session === null ? null : host.cwdOf(session);
				return apiJson(root == null ? [] : await listWorkspaceFiles(root));
			}
			if (url.pathname === "/api/upload" && request.method === "POST") {
				const uploadSession = url.searchParams.get("session") ?? "";
				const root = host.cwdOf(uploadSession);
				if (root == null) return apiJson({ error: "no session" }, { status: 400 });
				const form = await request.formData();
				const file = form.get("file");
				if (!(file instanceof File)) return apiJson({ error: "no file" }, { status: 400 });
				const dir = join(root, ".eta-attachments");
				await mkdir(dir, { recursive: true });
				const safeName = file.name.replace(/[^\w.-]/g, "_").slice(-80) || "image.bin";
				const path = join(dir, `${Date.now().toString(36)}-${safeName}`);
				await writeFile(path, new Uint8Array(await file.arrayBuffer()));
				return apiJson({ path: `.eta-attachments/${path.slice(path.lastIndexOf("/") + 1)}`, absolute: path });
			}
			if (url.pathname === "/api/settings") {
				if (request.method === "POST") {
					const patch = (await request.json()) as Record<string, unknown>;
					return apiJson(await host.saveSettings(patch));
				}
				return apiJson(host.settings());
			}
			if (url.pathname === "/api/sessions") {
				return apiJson(host.sidebar());
			}
			if (url.pathname === "/api/history") {
				const session = url.searchParams.get("session");
				const before = Number(url.searchParams.get("before") ?? "0");
				const limit = Math.min(500, Number(url.searchParams.get("limit") ?? "100") || 100);
				if (session === null || !Number.isFinite(before) || before <= 0)
					return apiError("bad request", 400);
				const messages = await host.historyOf(session, before, limit);
				return messages === undefined ? apiError("not found", 404) : apiJson(messages);
			}
			if (url.pathname === "/api/models") {
				const session = url.searchParams.get("session");
				try {
					return apiJson(session === null ? host.modelCatalog() : host.modelInfo(session));
				} catch {
					return apiJson({ models: [{ id: "faux", label: "faux echo" }], current: "faux" });
				}
			}
			if (request.method === "POST" && url.pathname === "/api/paste") {
				const session = url.searchParams.get("session") ?? "";
				const body = (await request.json()) as { text?: string };
				const text = body.text ?? "";
				if (text.length <= 4096) return apiJson({ path: null });
				const cwd = host.cwdOf(session);
				if (cwd === undefined) return apiError("no session", 404);
				const path = `.eta-paste-${Date.now().toString(36)}.txt`;
				await Bun.write(`${cwd}/${path}`, text);
				return apiJson({ path });
			}
			if (url.pathname === "/api/search") {
				return apiJson({
					query: url.searchParams.get("q") ?? "",
					hits: host.search(url.searchParams.get("q") ?? ""),
				});
			}
			if (url.pathname === "/api/git/status") {
				const session = url.searchParams.get("session");
				const root = session === null ? undefined : host.cwdOf(session);
				if (root === undefined) return apiJson(notGitStatus());
				return apiJson(await gitStatus(root));
			}
			if (url.pathname === "/api/git/diff") {
				const session = url.searchParams.get("session");
				const root = session === null ? undefined : host.cwdOf(session);
				const relPath = url.searchParams.get("path");
				const kindParam = url.searchParams.get("kind");
				const kind: GitDiffKind = kindParam === "index" || kindParam === "untracked" ? kindParam : "worktree";
				if (root === undefined || relPath === null) return apiError("not found", 404);
				const diff = await gitDiff(root, relPath, kind);
				return diff === undefined ? apiError("not found", 404) : apiJson(diff);
			}
			const fileSession = url.searchParams.get("session");
			const filePath = url.searchParams.get("path");
			if (url.pathname === "/api/file" && fileSession !== null && filePath !== null) {
				const text = host.fileText(fileSession, filePath);
				return text === undefined
					? apiError("not found", 404)
					: apiJson({ path: filePath, text });
			}
			if (options.native !== undefined) {
				if (url.pathname === "/api/native/info") {
					return apiJson({
						isDesktop: true,
						platform: options.platform ?? process.platform,
						appVersion: options.appVersion ?? "0.1.0",
					});
				}
				if (url.pathname === "/api/native/folder-dialog" && request.method === "POST") {
					const input = (await request.json()) as { startingFolder?: string };
					return apiJson({ path: await options.native.folderDialog(input) });
				}
				if (url.pathname === "/api/native/save-file" && request.method === "POST") {
					const input = (await request.json()) as { content: string; filename: string };
					return apiJson({ path: await options.native.saveFile(input) });
				}
				if (url.pathname === "/api/native/context-menu" && request.method === "POST") {
					const input = (await request.json()) as { items: unknown[] };
					options.native.contextMenu(input);
					return new Response(null, { status: 202, headers: CORS_HEADERS });
				}
			}
			const distFile = resolve(webDist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
			if (distFile.startsWith(`${webDist}/`) && existsSync(distFile) && (await Bun.file(distFile).exists())) {
				const ext = distFile.slice(distFile.lastIndexOf("."));
				return new Response(Bun.file(distFile), {
					headers: {
						"content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
						/* `assets/` is vite's content-hashed output: the name moves when the bytes do, so
						   it can be pinned for a year. Everything beside it — index.html, the brand font,
						   the tray icons — keeps its name across releases and has to be revalidated. A
						   cached index.html is how a rebuilt client goes on painting last build's
						   stylesheet, and a webview is the engine that does it. */
						"cache-control": distFile.startsWith(`${webDist}/assets/`) ? "public, max-age=31536000, immutable" : "no-cache",
					},
				});
			}
			const index = `${webDist}/index.html`;
			if (existsSync(index)) {
				return new Response(Bun.file(index), {
					headers: { "content-type": CONTENT_TYPES[".html"]!, "cache-control": "no-cache" },
				});
			}
			return new Response("eta-server up; eta-web not built yet", { status: 503 });
		},
		websocket: {
			open(socket: Socket) {
				if (socket.data.kind === "term") {
					terms.open(socket);
					return;
				}
				sockets.add(socket);
				syncPatchCapable();
				send(socket, { type: "hello", sessions: host.sidebar(), attach: host.attachPointer });
				for (const name of [...host.names()]) {
					const view = host.viewOf(name);
					if (view !== undefined) {
						send(socket, { channel: "view", session: name, version: host.viewVersion(name), view });
						// This socket now holds that exact transcript, so the frames that follow
						// it are allowed to leave the transcript out.
						host.rememberView(name, view);
					}
					for (const frame of host.ringOf(name)?.tail() ?? []) send(socket, { channel: "dev", frame });
				}
			},
			close(socket: Socket) {
				if (socket.data.kind === "term") {
					terms.close(socket);
					return;
				}
				sockets.delete(socket);
				opTails.delete(socket);
				syncPatchCapable();
			},
			async message(socket: Socket, raw: string | Buffer) {
				if (socket.data.kind === "term") {
					terms.message(socket, raw);
					return;
				}
				let message: ClientMessage;
				try {
					message = decodeClientMessage(String(raw));
				} catch {
					send(socket, { type: "error", message: "bad frame" });
					return;
				}
				// A resync is a read, not an op: answer it on this socket alone with
				// the whole view and re-point the patch baseline at it.
				if (message.op === "resync") {
					const view = host.viewOf(message.session);
					if (view !== undefined) {
						host.rememberView(message.session, view);
						send(socket, {
							channel: "view",
							session: message.session,
							version: host.viewVersion(message.session),
							view,
						});
					}
					return;
				}
				// Ops from one connection apply strictly in arrival order.
				const run = async () => {
					try {
						await applyOp(host, message);
						if (message.op === "session.create") send(socket, { type: "created", name: message.name });
						if (message.op === "session.delete") send(socket, { type: "deleted", name: message.name });
						send(socket, { type: "sessions", sessions: host.sidebar() });
					} catch (error) {
						const text =
							error instanceof UnknownPersonaError || error instanceof Error ? error.message : String(error);
						send(socket, { type: "error", message: text });
					}
				};
				const previous = opTails.get(socket) ?? Promise.resolve();
				const chain = previous.then(run, run);
				opTails.set(socket, chain);
				await chain;
			},
		},
	});
	const opTails = new Map<Socket, Promise<void>>();
	let nextSocketId = 1;

	return {
		host,
		port: server.port as number,
		push(message) {
			for (const socket of sockets) send(socket, message);
		},
		close() {
			unsubscribe();
			server.stop();
			terms.killAll();
			void host.close();
		},
	};
}

export async function applyOp(host: Host, message: ClientMessage): Promise<void> {
	switch (message.op) {
		case "focus":
			host.focus(message.session);
			return;
		case "resync":
			return;
		case "prompt":
			host.queue(message.session, message.text, message.mode ?? "queue");
			return;
		case "goal":
			host.goal(message.session, message.action, message.objective);
			return;
		case "loopRemove":
			host.loopRemove(message.session, message.id);
			return;
		case "loopToggle":
			host.loopToggle(message.session, message.id, message.paused);
			return;
		case "loopCreate":
			host.loopCreate(message.session, message.id, message.note, message.every, message.cron);
			return;
		case "taskCreate":
			host.taskCreate(message.session, message.content, message.priority);
			return;
		case "taskUpdate":
			host.taskUpdate(message.session, message.id, {
				...(message.content === undefined ? {} : { content: message.content }),
				...(message.priority === undefined ? {} : { priority: message.priority }),
			});
			return;
		case "taskRemove":
			host.taskRemove(message.session, message.id);
			return;
		case "taskSet":
			host.taskSet(message.session, message.id, message.status);
			return;
		case "btwOpen":
			await host.btwOpen(message.session, message.kind);
			break;
		case "modelSet":
			await host.modelSet(message.session, message.modelId);
			break;
		case "personaSet":
			await host.personaSet(message.session, message.personaId);
			break;
		case "session.pin":
			host.setMeta(message.session, { pinned: message.pinned });
			break;
		case "session.archive":
			host.setMeta(message.session, { archived: message.archived });
			break;
		case "session.rename":
			host.setMeta(message.session, { title: message.title });
			break;
		case "thinkingLevel":
			await host.thinkingLevel(message.session, message.level);
			break;
		case "queueRemove":
			host.queueRemove(message.session, message.entryId);
			break;
			return;
		case "btwAsk":
			await host.btwAsk(message.session, message.threadId, message.question);
			return;
		case "btwAnswer":
			host.btwAnswer(message.session, message.threadId, message.question, message.answer);
			return;
		case "btwSave":
			host.btwSave(message.session, message.threadId);
			return;
		case "btwHandoff":
			host.btwHandoff(message.session, message.threadId);
			return;
		case "btwClear":
			host.btwClear(message.session, message.threadId);
			return;
		case "stateDelete":
			host.stateSet(message.session, message.key, null);
			return;
		case "subagentStop":
			host.subagentStop(message.session, message.id);
			return;
		case "compact":
			await host.compact(message.session);
			return;
		case "abort":
			await host.abort(message.session);
			return;
		case "answer": {
			const ask = host.askOf(message.session);
			ask?.answer(message.questionId, message.response as Parameters<typeof ask.answer>[1]);
			return;
		}
		case "askAbort": {
			const ask = host.askOf(message.session);
			ask?.abort(message.questionId);
			await host.abort(message.session);
			return;
		}
		case "session.create":
			await host.createSession(
				message.name,
				message.personaId,
				expandHome(message.cwd ?? process.cwd()),
				message.modelId,
			);
			if (message.prompt !== undefined && message.prompt.length > 0)
				host.queue(message.name, message.prompt, "queue");
			return;
		case "session.delete":
			await host.deleteSession(message.name);
			return;
	}
}

/** Accepts "~" and "~/..." from hand-typed cwd fields. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const WALK_IGNORED = new Set(["node_modules", "dist", "target", "build", ".git"]);

/** Workspace files for @-mentions: recursive, newest-first, capped at 50 relative paths. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
	const found: { path: string; mtime: number }[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 6 || found.length >= 2000) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || WALK_IGNORED.has(entry.name)) continue;
				await walk(join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile() || entry.name.startsWith(".")) continue;
			const info = await stat(join(dir, entry.name)).catch(() => null);
			found.push({ path: relative(root, join(dir, entry.name)), mtime: info?.mtimeMs ?? 0 });
		}
	};
	await walk(root, 0);
	return found
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, 50)
		.map((entry) => entry.path);
}
