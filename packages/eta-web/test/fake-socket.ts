/** In-memory WebSocket stand-in. Tests assert on `sent` / `fire`, not on React. */
export class FakeSocket {
	static instances: FakeSocket[] = [];
	static sent: string[] = [];
	readyState = 1;
	listeners = new Map<string, ((event: unknown) => void)[]>();

	constructor(_url: string) {
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, cb: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
	}

	send(data: string): void {
		FakeSocket.sent.push(data);
	}

	close(): void {}

	fire(type: string, event: unknown): void {
		for (const cb of this.listeners.get(type) ?? []) cb(event);
	}

	static reset(): void {
		FakeSocket.instances = [];
		FakeSocket.sent = [];
	}

	static last(): Record<string, unknown> {
		const raw = FakeSocket.sent.at(-1);
		if (raw === undefined) throw new Error("FakeSocket.sent is empty");
		return JSON.parse(raw) as Record<string, unknown>;
	}
}
