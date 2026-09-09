/**
 * F2 / G9 acceptance: two raw web sockets, no in-process access, see the same
 * three channels and can drive every op back through the host.
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryStorage, StorageBackedSession } from "@eta/core";
import { describe, expect, it } from "vitest";
import { Host } from "../src/host.ts";
import { startWs } from "../src/ws.ts";
import { decodeFrame, type ChannelFrame } from "../src/channels.ts";

const describeBun = typeof Bun !== "undefined" ? describe : describe.skip;

const makeAgent = async (id: string) => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hello over the wire")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const session = new StorageBackedSession({ id, createdAt: Date.now(), storageVersion: 1 }, storage);
	return EtaAgent.create({ session, models, model: faux.getModel(), heartbeatMs: 0 }, BACKGROUND_CONTEXT);
};

async function settle(predicate: () => boolean, rounds = 200): Promise<void> {
	for (let attempt = 0; attempt < rounds && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface Peer {
	msgs: ChannelFrame[];
	send(op: unknown): void;
	close(): void;
}

function connect(port: number): Promise<Peer> {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${port}/`);
		const msgs: ChannelFrame[] = [];
		sock.onmessage = (event) => msgs.push(decodeFrame(String(event.data)));
		sock.onopen = () =>
			resolve({
				msgs,
				send: (op) => sock.send(JSON.stringify(op)),
				close: () => sock.close(),
			});
		sock.onerror = reject;
	});
}

describeBun("F2 WebSocket shell", () => {
	it("two peers see the same frames and ops drive the core back", async () => {
		const host = new Host();
		await host.open("a", () => makeAgent("eta-ws"));
		const ws = startWs(host);
		const a = await connect(ws.port);
		const b = await connect(ws.port);

		expect(a.msgs.some((f) => f.channel === "view" && f.session === "a")).toBe(true);

		a.send({ op: "prompt", args: ["hi over the wire"] });
		await settle(() => a.msgs.some((f) => f.channel === "agent" && f.event.type === "run_start"));
		await settle(() => a.msgs.some((f) => f.channel === "view" && f.view.messages.length >= 2));

		expect(b.msgs.some((f) => f.channel === "agent" && f.event.type === "run_start" && f.session === "a")).toBe(true);
		expect(b.msgs.some((f) => f.channel === "view" && f.view.messages.length >= 2)).toBe(true);

		a.send({ op: "taskSet", args: ["missing", "completed"] });
		await new Promise((resolve) => setTimeout(resolve, 20));

		a.close();
		b.close();
		ws.close();
		await host.close();
	});
});
