/**
 * The F2 thin OS shell: the same three channels over a WebSocket, plus a
 * small op protocol for driving back. A second front-end (remote window, CI
 * recorder) gets the identical contract the in-process GUI gets.
 */

import type { Host } from "./host.ts";
import { decodeFrame, encodeFrame, type ChannelFrame } from "./channels.ts";

export interface WsClientOp {
	session?: string;
	op: string;
	args?: unknown[];
}

export interface WsHandle {
	port: number;
	close(): void;
}

interface WsData {
	detach?: () => void;
}

function applyOp(host: Host, message: string): void {
	let parsed: WsClientOp;
	try {
		parsed = JSON.parse(message) as WsClientOp;
	} catch {
		return;
	}
	const session = parsed.session ?? host.attachPointer;
	if (session === null) return;
	const args = parsed.args ?? [];
	const swallow = (p: Promise<unknown>) => void p.catch(() => undefined);
	switch (parsed.op) {
		case "focus":
			host.focus(session);
			break;
		case "prompt":
			swallow(host.prompt(session, args[0] as string));
			break;
		case "goal":
			host.goal(session, args[0] as "set" | "pause" | "resume" | "clear", args[1] as string | undefined);
			break;
		case "loopToggle":
			host.loopToggle(session, args[0] as string, args[1] as boolean);
			break;
		case "taskSet":
			host.taskSet(session, args[0] as string, args[1] as "pending" | "in_progress" | "completed" | "cancelled");
			break;
		case "compact":
			swallow(host.compact(session));
			break;
		case "abort":
			swallow(host.abort(session));
			break;
		case "answer":
			host.askOf(session)?.answer(args[0] as string, args[1] as never);
			break;
		case "btwOpen":
			host.btwOpen(session, args[0] as "contextual" | "tangent");
			break;
		case "btwAnswer":
			host.btwAnswer(session, args[0] as string, args[1] as string, args[2] as string);
			break;
		case "btwSave":
			host.btwSave(session, args[0] as string);
			break;
		case "btwClear":
			host.btwClear(session, args[0] as string);
			break;
	}
}

export function startWs(host: Host, port = 0): WsHandle {
	const server = Bun.serve<WsData>({
		port,
		fetch(request, srv) {
			if (request.headers.get("upgrade") === "websocket") {
				srv.upgrade(request, { data: {} });
				return undefined as unknown as Response;
			}
			return new Response("eta host");
		},
		websocket: {
			open(ws) {
				const off = host.subscribe((frame: ChannelFrame) => ws.send(encodeFrame(frame)));
				ws.data.detach = off;
				const name = host.attachPointer;
				if (name === null) return;
				const view = host.viewOf(name);
				if (view !== undefined) ws.send(encodeFrame({ channel: "view", session: name, view }));
				for (const frame of host.ringOf(name)?.tail() ?? []) ws.send(encodeFrame({ channel: "dev", frame }));
			},
			message(ws, raw) {
				applyOp(host, typeof raw === "string" ? raw : raw.toString());
			},
			close(ws) {
				ws.data.detach?.();
			},
		},
	});
	return { port: server.port as number, close: () => server.stop() };
}
