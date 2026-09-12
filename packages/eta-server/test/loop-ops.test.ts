/**
 * The GUI write path for loops, end to end: an op that a person clicks has to land in
 * core *and* come back in the frame that follows it, and a loop has to fire whether or
 * not anybody happens to be running. These four cover one failure each — a frame that
 * reports the state from before the op, a pause that never reports back, a loop created
 * with nothing to trigger it, and a loop that only fires when something else ends a run.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type EtaServer, type EtaServerOptions } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";

async function withServer(options: { heartbeatMs?: number }, run: (server: EtaServer) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "eta-loop-test-"));
	const server = await startServer({
		port: 0,
		cwd,
		webDist: join(cwd, "no-dist"),
		configPath: join(cwd, "no-config.json"),
		dataDir: join(cwd, "sessions"),
		...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
	});
	try {
		await run(server);
	} finally {
		server.close();
	}
}

class Reader {
	private readonly seen: ServerMessage[] = [];
	private readonly waiters: { match(m: ServerMessage): boolean; resolve(m: ServerMessage): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }[] = [];

	constructor(socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			for (const [index, waiter] of this.waiters.entries()) {
				if (!waiter.match(message)) continue;
				this.waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
				return;
			}
			this.seen.push(message);
		});
	}

	/** The next view frame whose JSON carries `needle`. */
	viewFrameWith(needle: string, timeoutMs = 5000): Promise<ServerMessage> {
		return this.next((m) => "channel" in m && m.channel === "view" && JSON.stringify(m).includes(needle), needle, timeoutMs);
	}

	/** The next frame whose JSON carries `needle`, or a timeout naming what did arrive. */
	frameWith(needle: string, timeoutMs = 5000): Promise<ServerMessage> {
		return this.next((m) => JSON.stringify(m).includes(needle), needle, timeoutMs);
	}

	private next(
		match: (m: ServerMessage) => boolean,
		needle: string,
		timeoutMs: number,
	): Promise<ServerMessage> {
		const queued = this.seen.find(match);
		if (queued !== undefined) {
			this.seen.splice(this.seen.indexOf(queued), 1);
			return Promise.resolve(queued);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const kinds = this.seen
					.map((m) => String((m as { channel?: string; type?: string }).channel ?? (m as { type?: string }).type ?? "?"))
					.join(", ");
				reject(new Error(`no frame containing ${needle} (saw: ${kinds})`));
			}, timeoutMs);
			this.waiters.push({ match, resolve, reject, timer });
		});
	}
}

async function opened(server: EtaServer, name = "s1"): Promise<{ socket: WebSocket; reader: Reader }> {
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	const reader = new Reader(socket);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	socket.send(JSON.stringify({ op: "session.create", name, personaId: "Thinker" }));
	await reader.frameWith('"created"', 5000).catch(() => undefined);
	return { socket, reader };
}

const send = (socket: WebSocket, message: object): void => {
	socket.send(JSON.stringify(message));
};

describe("loop ops from the GUI", () => {
	it("reports a created loop without waiting for a run to move the journal", async () => {
		await withServer({}, async (server) => {
			const { socket, reader } = await opened(server);
			send(socket, { op: "loopCreate", session: "s1", id: "l1", note: "check the build", every: "5m" });
			// Nothing else happens after the op: no prompt, no run. A frame that arrives
			// with the loop in it was therefore projected after the create.
			const frame = await reader.viewFrameWith('"id":"l1"');
			expect(JSON.stringify(frame)).toContain('"every":"5m"');
			expect(JSON.stringify(frame)).toContain('"runCount":0');
			expect(JSON.stringify(frame)).toContain('"paused":false');
			socket.close();
		});
	});

	it("reports a pause, which writes nothing to the journal", async () => {
		await withServer({}, async (server) => {
			const { socket, reader } = await opened(server);
			send(socket, { op: "loopCreate", session: "s1", id: "l2", note: "tick", every: "5m" });
			await reader.viewFrameWith('"id":"l2"');
			send(socket, { op: "loopToggle", session: "s1", id: "l2", paused: true });
			const frame = await reader.viewFrameWith('"paused":true');
			expect(JSON.stringify(frame)).toContain('"id":"l2"');
			socket.close();
		});
	});

	it("refuses a loop with nothing to trigger it, and says so", async () => {
		await withServer({}, async (server) => {
			const { socket, reader } = await opened(server);
			send(socket, { op: "loopCreate", session: "s1", id: "l3", note: "no cadence" });
			const frame = await reader.frameWith("needs an interval");
			expect(frame).toMatchObject({ type: "error" });
			expect(JSON.stringify(frame)).toContain("l3");
			// And it was not created: a loop that can never fire would sit in the panel
			// for its whole lifetime looking like a scheduled thing.
			send(socket, { op: "loopCreate", session: "s1", id: "l4", note: "bad cadence", every: "soon" });
			expect(await reader.frameWith("can't parse interval")).toMatchObject({ type: "error" });
			socket.close();
		});
	});

	it("wakes an idle session on the loop's own clock, not on the heartbeat's", async () => {
		// No heartbeatMs here: this is the shipped default, a backstop of 30s. A loop that
		// asks for 300ms has to be waited on for 300ms — a fixed grid would sit silent for
		// up to a whole cadence and the interval on the row would be a label, not a schedule.
		await withServer({}, async (server) => {
			const { socket, reader } = await opened(server);
			send(socket, { op: "loopCreate", session: "s1", id: "l5", note: "wake up", every: "300ms" });
			await reader.viewFrameWith('"id":"l5"');
			const at = Date.now();
			// The loop's own followUp text is the prompt the wake starts the run with, so
			// seeing it in the transcript proves the idle session was started by the loop
			// and not by anything the test asked for.
			const frame = await reader.frameWith("[loop l5] wake up", 2000);
			expect(JSON.stringify(frame)).toContain("wake up");
			expect(Date.now() - at).toBeLessThan(2_000);
			socket.close();
		});
	});
});
