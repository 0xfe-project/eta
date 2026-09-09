/**
 * HTTP + WebSocket host for the eta front-end (GUI-PLAN v2 W0.2/W0.3/W0.6).
 * One bun process, core in-process; every browser tab is a thin observer of
 * the three channels. Static: serves the built eta-web SPA when present.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { encodeMessage, decodeClientMessage, type ClientMessage, type ServerMessage } from "./protocol.ts";
import { Host } from "./host.ts";
import { listPersonaSummaries } from "./personas.ts";
import { UnknownPersonaError } from "./agent.ts";

export interface EtaServerOptions {
	port?: number;
	hostname?: string;
	cwd?: string;
	webDist?: string;
	configPath?: string;
	dataDir?: string;
}

export interface EtaServer {
	host: Host;
	port: number;
	close(): void;
}

type Socket = ServerWebSocket<{ socketId: number }>;

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
	const host = new Host({ ...(options.configPath === undefined ? {} : { configPath: options.configPath }), ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) });
	await host.restoreSessions();
	const cwd = options.cwd ?? process.cwd();
	const webDist = options.webDist ?? resolve(import.meta.dir, "../../eta-web/dist");
	const sessionsDirty = new WeakMap<Socket, boolean>();

	const send = (socket: Socket, message: ServerMessage): void => {
		try {
			socket.send(encodeMessage(message));
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

	const unsubscribe = host.subscribe((frame) => {
		for (const socket of sockets) {
			send(socket, frame);
			flushSessions(socket);
		}
	});

	const server = Bun.serve<{ socketId: number }>({
		port: options.port ?? 3000,
		hostname: options.hostname ?? "0.0.0.0",
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws") {
				if (srv.upgrade(request, { data: { socketId: nextSocketId++ } })) return;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/api/health") {
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/personas") {
				return Response.json(await listPersonaSummaries(cwd));
			}
			if (url.pathname === "/api/sessions") {
				return Response.json(host.sidebar());
			}
			if (url.pathname === "/api/models") {
				const session = url.searchParams.get("session");
				try {
					return Response.json(session === null ? host.modelCatalog() : host.modelInfo(session));
				} catch {
					return Response.json({ models: [{ id: "faux", label: "faux echo" }], current: "faux" });
				}
			}
			const filesSession = url.searchParams.get("files") ?? url.searchParams.get("session");
			if (filesSession !== null) {
				return Response.json(host.filesOf(filesSession));
			}
			if (request.method === "POST" && url.pathname === "/api/paste") {
				const session = url.searchParams.get("session") ?? "";
				const body = (await request.json()) as { text?: string };
				const text = body.text ?? "";
				if (text.length <= 4096) return Response.json({ path: null });
				const cwd = host.cwdOf(session);
				if (cwd === undefined) return new Response("no session", { status: 404 });
				const path = `.eta-paste-${Date.now().toString(36)}.txt`;
				await Bun.write(`${cwd}/${path}`, text);
				return Response.json({ path });
			}
			if (url.pathname === "/api/search") {
				return Response.json({ query: url.searchParams.get("q") ?? "", hits: host.search(url.searchParams.get("q") ?? "") });
			}
			const fileSession = url.searchParams.get("session");
			const filePath = url.searchParams.get("path");
			if (url.pathname === "/api/file" && fileSession !== null && filePath !== null) {
				const text = host.fileText(fileSession, filePath);
				return text === undefined ? new Response("not found", { status: 404 }) : Response.json({ path: filePath, text });
			}
			const distFile = resolve(webDist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
			if (distFile.startsWith(`${webDist}/`) && existsSync(distFile) && (await Bun.file(distFile).exists())) {
				const ext = distFile.slice(distFile.lastIndexOf("."));
				return new Response(Bun.file(distFile), { headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" } });
			}
			const index = `${webDist}/index.html`;
			if (existsSync(index)) {
				return new Response(Bun.file(index), { headers: { "content-type": CONTENT_TYPES[".html"]! } });
			}
			return new Response("eta-server up; eta-web not built yet", { status: 503 });
		},
		websocket: {
			open(socket: Socket) {
				sockets.add(socket);
				send(socket, { type: "hello", sessions: host.sidebar(), attach: host.attachPointer });
				for (const name of [...host.names()]) {
					const view = host.viewOf(name);
					if (view !== undefined) send(socket, { channel: "view", session: name, view });
					for (const frame of host.ringOf(name)?.tail() ?? []) send(socket, { channel: "dev", frame });
				}
			},
			close(socket: Socket) {
				sockets.delete(socket);
				opTails.delete(socket);
			},
			async message(socket: Socket, raw: string | Buffer) {
				let message: ClientMessage;
				try {
					message = decodeClientMessage(String(raw));
				} catch {
					send(socket, { type: "error", message: "bad frame" });
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
					const text = error instanceof UnknownPersonaError || error instanceof Error ? error.message : String(error);
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
	const sockets = new Set<Socket>();
	let nextSocketId = 1;

	return {
		host,
		port: server.port as number,
		close() {
			unsubscribe();
			server.stop();
			void host.close();
		},
	};
}

export async function applyOp(host: Host, message: ClientMessage): Promise<void> {
	switch (message.op) {
		case "focus":
			host.focus(message.session);
			return;
		case "prompt":
			host.queue(message.session, message.text, message.mode ?? "queue");
			return;
		case "goal":
			host.goal(message.session, message.action, message.objective);
			return;
		case "loopToggle":
			host.loopToggle(message.session, message.id, message.paused);
			return;
		case "taskSet":
			host.taskSet(message.session, message.id, message.status);
			return;
		case "btwOpen":
			await host.btwOpen(message.session, message.kind);
			break;
		case "btwAsk":
			host.btwAsk(message.session, message.threadId, message.question);
			break;
		case "modelSet":
			await host.modelSet(message.session, message.modelId);
			break;
		case "queueRemove":
			host.queueRemove(message.session, message.entryId);
			break;
			return;
		case "btwAnswer":
			host.btwAnswer(message.session, message.threadId, message.question, message.answer);
			return;
		case "btwSave":
			host.btwSave(message.session, message.threadId);
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
		case "session.create":
			await host.createSession(message.name, message.personaId, message.cwd ?? process.cwd(), message.modelId);
			if (message.prompt !== undefined && message.prompt.length > 0) await host.prompt(message.name, message.prompt);
			return;
		case "session.delete":
			await host.closeSession(message.name);
			return;
	}
}
