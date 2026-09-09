import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type EtaServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";

async function withServer(run: (server: EtaServer) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "eta-inbox-test-"));
	const server = await startServer({ port: 0, cwd, webDist: join(cwd, "no-dist") });
	try {
		await run(server);
	} finally {
		server.close();
	}
}

async function connect(server: EtaServer): Promise<{ socket: WebSocket; next: () => Promise<ServerMessage>; until: (p: (m: ServerMessage) => boolean) => Promise<ServerMessage> }> {
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
	const queue: ServerMessage[] = [];
	const waiters: ((m: ServerMessage) => void)[] = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as ServerMessage;
		const waiter = waiters.shift();
		if (waiter !== undefined) waiter(message);
		else queue.push(message);
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	const next = (): Promise<ServerMessage> => {
		const queued = queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => waiters.push(resolve));
	};
	const until = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
		for (;;) {
			const message = await next();
			if (predicate(message)) return message;
		}
	};
	return { socket, next, until };
}

const send = (socket: WebSocket, message: object): void => {
	socket.send(JSON.stringify(message));
};

const asTasks = (message: ServerMessage): { id: string; status: string; events: unknown[] }[] | undefined => {
	return "type" in message && message.type === "tasks" ? (message.tasks as unknown as { id: string; status: string; events: unknown[] }[]) : undefined;
};

describe("agent inbox", () => {
	it("create, approve dispatches a child session, run_end closes the task as done", async () => {
		await withServer(async (server) => {
			const client = await connect(server);
			await client.next();

			send(client.socket, { op: "task.create", title: "write the readme", description: "short and dry", targetProject: process.cwd() });
			const created = await client.until((m) => asTasks(m)?.some((t) => t.status === "pending") === true);
			const task = asTasks(created)!.find((t) => t.status === "pending")!;
			expect(task.events.length).toBeGreaterThanOrEqual(1);

			send(client.socket, { op: "task.approve", id: task.id });
			await client.until((m) => asTasks(m)?.some((t) => t.id === task.id && t.status === "running") === true);
			expect(server.host.agentOf(`task-${task.id}`)).toBeDefined();

			const done = await client.until((m) => asTasks(m)?.some((t) => t.id === task.id && t.status === "done") === true);
			const finished = asTasks(done)!.find((t) => t.id === task.id)!;
			expect(finished.events.some((event) => JSON.stringify(event).includes("child run finished"))).toBe(true);
			expect(finished.events.length).toBeGreaterThanOrEqual(3);

			send(client.socket, { op: "task.clearDone" });
			await client.until((m) => asTasks(m)?.length === 0);
			client.socket.close();
		});
	});

	it("dismiss removes the task and kills the child session", async () => {
		await withServer(async (server) => {
			const client = await connect(server);
			await client.next();
			send(client.socket, { op: "task.create", title: "t", description: "d" });
			const created = await client.until((m) => asTasks(m)?.some((t) => t.status === "pending") === true);
			const task = asTasks(created)!.find((t) => t.status === "pending")!;
			send(client.socket, { op: "task.approve", id: task.id });
			await client.until((m) => asTasks(m)?.some((t) => t.id === task.id && t.status === "running") === true);
			send(client.socket, { op: "task.dismiss", id: task.id });
			await client.until((m) => asTasks(m)?.length === 0);
			expect(server.host.agentOf(`task-${task.id}`)).toBeUndefined();
			client.socket.close();
		});
	});
});
