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
import { InboxStore, buildTaskPrompt } from "./inbox.ts";
import { Host } from "./host.ts";
import { join } from "node:path";
import { listPersonaSummaries } from "./personas.ts";
import { UnknownPersonaError } from "./agent.ts";

export interface EtaServerOptions {
	port?: number;
	hostname?: string;
	cwd?: string;
	webDist?: string;
}

export interface EtaServer {
	host: Host;
	inbox: InboxStore;
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
	const host = new Host();
	const cwd = options.cwd ?? process.cwd();
	const inbox = new InboxStore(join(cwd, ".eta-inbox"));
	const webDist = options.webDist ?? resolve(import.meta.dir, "../../eta-web/dist");
	const sessionsDirty = new WeakMap<Socket, boolean>();

	const send = (socket: Socket, message: ServerMessage): void => {
		socket.send(encodeMessage(message));
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
		const child = frame.channel === "view" || frame.channel === "agent" ? inbox.childOf(frame.session) : undefined;
		if (child !== undefined && child.status === "running") {
			if (frame.channel === "view" && frame.view.pendingAsk !== undefined) inbox.needsInput(child.id, "child session is waiting for an answer");
			if (frame.channel === "agent" && frame.event.type === "run_end") inbox.complete(child.id, "child run finished");
		} else if (child !== undefined && child.status === "needs_input" && frame.channel === "agent" && frame.event.type === "run_end") {
			inbox.complete(child.id, "child run finished after answer");
		}
		for (const socket of sockets) {
			send(socket, frame);
			flushSessions(socket);
		}
	});

	const unsubscribeTasks = inbox.onChanged((tasks) => {
		for (const socket of sockets) send(socket, { type: "tasks", tasks });
	});

	const server = Bun.serve<{ socketId: number }>({
		port: options.port ?? 3000,
		hostname: options.hostname ?? "127.0.0.1",
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
			const filesSession = url.searchParams.get("files");
			if (filesSession !== null) {
				return Response.json(host.filesOf(filesSession));
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
				send(socket, { type: "hello", sessions: host.sidebar(), attach: host.attachPointer, tasks: inbox.list() });
				for (const name of [...host.names()]) {
					const view = host.viewOf(name);
					if (view !== undefined) send(socket, { channel: "view", session: name, view });
					for (const frame of host.ringOf(name)?.tail() ?? []) send(socket, { channel: "dev", frame });
				}
			},
			close(socket: Socket) {
				sockets.delete(socket);
			},
			async message(socket: Socket, raw: string | Buffer) {
				let message: ClientMessage;
				try {
					message = decodeClientMessage(String(raw));
				} catch {
					send(socket, { type: "error", message: "bad frame" });
					return;
				}
				try {
					await applyOp(host, inbox, cwd, message);
					if (message.op === "session.create") send(socket, { type: "created", name: message.name });
					if (message.op === "session.delete") send(socket, { type: "deleted", name: message.name });
					send(socket, { type: "sessions", sessions: host.sidebar() });
				} catch (error) {
					const text = error instanceof UnknownPersonaError || error instanceof Error ? error.message : String(error);
					send(socket, { type: "error", message: text });
				}
			},
		},
	});
	const sockets = new Set<Socket>();
	let nextSocketId = 1;

	return {
		host,
		inbox,
		port: server.port as number,
		close() {
			unsubscribe();
			unsubscribeTasks();
			server.stop();
			void host.close();
		},
	};
}

export async function applyOp(host: Host, inbox: InboxStore, defaultCwd: string, message: ClientMessage): Promise<void> {
	switch (message.op) {
		case "focus":
			host.focus(message.session);
			return;
		case "prompt":
			await host.prompt(message.session, message.text);
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
			host.btwOpen(message.session, message.kind);
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
			await host.createSession(message.name, message.personaId, message.cwd ?? process.cwd());
			if (message.prompt !== undefined && message.prompt.length > 0) await host.prompt(message.name, message.prompt);
			return;
		case "session.delete":
			await host.closeSession(message.name);
			return;
		case "task.create":
			inbox.create({ title: message.title, description: message.description, targetProject: message.targetProject ?? defaultCwd });
			return;
		case "task.approve": {
			const task = inbox.of(message.id);
			if (task === undefined) throw new Error(`no task ${message.id}`);
			const child = `task-${message.id}`;
			await host.createSession(child, "Executor", task.targetProject || defaultCwd);
			const approved = inbox.approve(message.id, "approved locally");
			await host.prompt(child, buildTaskPrompt(approved ?? task));
			return;
		}
		case "task.dismiss": {
			const task = inbox.of(message.id);
			inbox.dismiss(message.id);
			if (task?.dispatch !== undefined) await host.closeSession(task.dispatch.childSession).catch(() => undefined);
			return;
		}
		case "task.clearDone":
			inbox.clearDone();
			return;
	}
}
