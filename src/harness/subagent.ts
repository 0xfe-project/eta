/**
 * Subagent manager (C7 lite, semantics inherited from pi-subagents'
 * agent-manager reasoning): background pool caps only TOP-LEVEL agents —
 * nested children don't take a slot because their parent already holds one,
 * and queueing a child behind its waiting parent is a guaranteed deadlock.
 * Depth caps how deep nesting goes (2), never how wide. Ownership: you only
 * control your own children; a parent reaching a terminal state stops its
 * descendants; usage rolls up through the chain.
 */

export interface SubagentUsage {
	input: number;
	output: number;
}

export interface SubagentSpec {
	prompt: string;
	model?: string;
	maxTurns?: number;
}

export type SubagentStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface SubagentRecord {
	id: string;
	parentId: string | undefined;
	depth: number;
	_blocking: boolean;
	background: boolean;
	status: SubagentStatus;
	usage: SubagentUsage;
	totalUsage: SubagentUsage;
	spec: SubagentSpec;
	turns: number;
	warnedWrapUp: boolean;
	children: string[];
	/** Steering notes queued for the runner to pick up at its next boundary. */
	notes: string[];
}

export type SubagentBusEvent =
	| "subagents:completed"
	| "subagents:failed"
	| "subagents:steered"
	| "subagents:rpc:spawn"
	| "subagents:rpc:stop"
	| "subagents:rpc:consume"
	| "subagents:rpc:reply";

export interface SubagentBus {
	emit(type: SubagentBusEvent, payload: Record<string, unknown>): void;
	on?(type: SubagentBusEvent, listener: (payload: Record<string, unknown>) => void): () => void;
}

/** Injected executor: the real one runs a second harness lane over pi-ai. */
export type SubagentRunner = (record: SubagentRecord, api: SubagentApi) => Promise<SubagentUsage>;

export interface SubagentApi {
	reportTurn(recordId: string): void;
	/** Take (and clear) steering notes for this child. */
	pendingNotes(recordId: string): string[];
}

export const DEPTH_CAP = 2;
export const DEFAULT_POOL_SIZE = 10;

export class SubagentManager {
	private records = new Map<string, SubagentRecord>();
	private sequence = 0;
	readonly maxBackground: number;
	readonly maxForeground: number;
	private runningBackground = 0;
	private runningForeground = 0;

	private readonly bus: SubagentBus;
	private readonly runner: SubagentRunner;

	constructor(bus: SubagentBus, runner: SubagentRunner, poolSize = DEFAULT_POOL_SIZE) {
		this.bus = bus;
		this.runner = runner;
		this.maxBackground = poolSize;
		this.maxForeground = poolSize;
	}

	spawn(spec: SubagentSpec, parentId?: string, blocking = false): SubagentRecord {
		const parent = parentId === undefined ? undefined : this.records.get(parentId);
		if (parentId !== undefined && parent === undefined) throw new Error(`unknown parent ${parentId}`);
		const depth = parent === undefined ? 1 : parent.depth + 1;
		if (depth > DEPTH_CAP) throw new Error(`depth cap ${DEPTH_CAP} exceeded`);
		const record: SubagentRecord = {
			id: `sub-${++this.sequence}`,
			parentId,
			depth,
			_blocking: blocking,
			background: !blocking,
			status: "queued",
			usage: { input: 0, output: 0 },
			totalUsage: { input: 0, output: 0 },
			spec,
			turns: 0,
			warnedWrapUp: false,
			children: [],
			notes: [],
		};
		this.records.set(record.id, record);
		if (parent) parent.children.push(record.id);
		this.pump();
		return record;
	}

	spawnAndWait(spec: SubagentSpec, parentId?: string): SubagentRecord {
		return this.spawn(spec, parentId, true);
	}

	get(id: string): SubagentRecord | undefined {
		return this.records.get(id);
	}

	list(): SubagentRecord[] {
		return [...this.records.values()];
	}

	/** Runner reports a turn; last warning before the hard stop. */
	reportTurn(id: string): void {
		const record = this.records.get(id);
		if (record === undefined) return;
		record.turns += 1;
		const max = record.spec.maxTurns;
		if (max !== undefined && record.turns >= max && record.status === "running") {
			this.stop(id, id);
			this.finish(record, "failed", record.usage);
		} else if (max !== undefined && record.turns === max - 1) {
			record.warnedWrapUp = true;
		}
	}

	/** Queue a steering note for a live child; ownership enforced like stop. */
	steer(id: string, byId: string | undefined, note: string): boolean {
		const record = this.records.get(id);
		if (record === undefined || (record.status !== "running" && record.status !== "queued")) return false;
		if (byId !== undefined && byId !== id && record.parentId !== byId) return false;
		record.notes.push(note);
		this.bus.emit("subagents:steered", { id: record.id, parentId: record.parentId, note });
		return true;
	}

	pendingNotes(id: string): string[] {
		const record = this.records.get(id);
		if (record === undefined) return [];
		const notes = [...record.notes];
		record.notes = [];
		return notes;
	}

	stop(id: string, byId: string | undefined): void {
		const record = this.records.get(id);
		if (record === undefined) throw new Error(`unknown agent ${id}`);
		if (byId !== undefined && byId !== id && record.parentId !== byId) {
			throw new Error(`not your child: ${id} owned by ${String(record.parentId)}`);
		}
		if (record.status === "running" || record.status === "queued") {
			this.release(record);
			this.finish(record, "stopped", record.usage);
		}
	}

	settle(id: string, usage: SubagentUsage, failed = false): void {
		const record = this.records.get(id);
		if (record === undefined || record.status !== "running") return;
		this.release(record);
		this.finish(record, failed ? "failed" : "done", usage);
	}

	private rpcSequence = 0;

	/** Client half of the RPC envelope: requestId in, one matched reply out. */
	rpc(topic: "spawn" | "stop" | "consume", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (this.bus.on === undefined) throw new Error("subagent bus has no on(): RPC needs a two-way bus");
		const requestId = `rpc-${(this.rpcSequence += 1)}`;
		return new Promise((resolve, reject) => {
			const off = this.bus.on?.("subagents:rpc:reply", (reply) => {
				if (reply.requestId !== requestId) return;
				off?.();
				if (reply.ok === true) resolve((reply.result ?? {}) as Record<string, unknown>);
				else reject(new Error(String(reply.error ?? "rpc failed")));
			});
			this.bus.emit(`subagents:rpc:${topic}`, { requestId, ...payload });
		});
	}

	/** Server half: answer spawn/stop/consume RPC on the bus on behalf of parentId. */
	serveRpc(parentId?: string): () => void {
		if (this.bus.on === undefined) throw new Error("subagent bus has no on(): RPC needs a two-way bus");
		const offs: (() => void)[] = [];
		const reply = (requestId: unknown, ok: boolean, extra: Record<string, unknown>) => {
			this.bus.emit("subagents:rpc:reply", { requestId, ok, ...extra });
		};
		offs.push(
			this.bus.on("subagents:rpc:spawn", ({ requestId, spec, blocking }) => {
				try {
					const record = this.spawn(spec as SubagentSpec, parentId, blocking === true);
					reply(requestId, true, { result: { id: record.id, status: record.status } });
				} catch (error) {
					reply(requestId, false, { error: String(error) });
				}
			}),
		);
		offs.push(
			this.bus.on("subagents:rpc:stop", ({ requestId, id }) => {
				try {
					this.stop(String(id), parentId ?? undefined);
					reply(requestId, true, { result: { id } });
				} catch (error) {
					reply(requestId, false, { error: String(error) });
				}
			}),
		);
		offs.push(
			this.bus.on("subagents:rpc:consume", ({ requestId, id }) => {
				const record = this.records.get(String(id));
				if (record === undefined) reply(requestId, false, { error: `unknown agent ${String(id)}` });
				else if (record.status === "running" || record.status === "queued")
					reply(requestId, false, { error: `still ${record.status}` });
				else reply(requestId, true, { result: { id: record.id, status: record.status, usage: record.totalUsage } });
			}),
		);
		return () => {
			for (const off of offs) off();
		};
	}

	private finish(record: SubagentRecord, status: SubagentStatus, usage: SubagentUsage): void {
		record.status = status;
		record.usage = usage;
		record.totalUsage = {
			input: record.totalUsage.input + usage.input,
			output: record.totalUsage.output + usage.output,
		};
		let node: SubagentRecord | undefined = record;
		while (node !== undefined) {
			const parent: SubagentRecord | undefined =
				node.parentId === undefined ? undefined : this.records.get(node.parentId);
			if (parent === undefined) break;
			parent.totalUsage = {
				input: parent.totalUsage.input + node.totalUsage.input,
				output: parent.totalUsage.output + node.totalUsage.output,
			};
			node = parent;
		}
		this.bus.emit(status === "done" ? "subagents:completed" : "subagents:failed", {
			id: record.id,
			parentId: record.parentId,
		});
		if (status === "done" || status === "failed" || status === "stopped") {
			for (const child of record.children) {
				const c = this.records.get(child);
				if (c !== undefined && (c.status === "running" || c.status === "queued")) this.stop(child, record.id);
			}
		}
		this.pump();
	}

	private release(record: SubagentRecord): void {
		if (record.status !== "running") return;
		if (this.occupiesForeground(record)) this.runningForeground -= 1;
		else if (this.occupiesBackgroundPool(record)) this.runningBackground -= 1;
	}

	private occupiesBackgroundPool(r: SubagentRecord): boolean {
		return r.background && r.parentId === undefined;
	}

	private occupiesForeground(r: SubagentRecord): boolean {
		return r._blocking && r.parentId === undefined;
	}

	private pump(): void {
		for (const record of this.records.values()) {
			if (record.status !== "queued") continue;
			const nested = record.parentId !== undefined;
			if (!nested && record._blocking && this.runningForeground >= this.maxForeground) continue;
			if (!nested && record.background && this.runningBackground >= this.maxBackground) continue;
			record.status = "running";
			if (!nested) {
				if (record._blocking) this.runningForeground += 1;
				else this.runningBackground += 1;
			}
			void Promise.resolve(
				this.runner(record, {
					reportTurn: (id) => this.reportTurn(id),
					pendingNotes: (id) => this.pendingNotes(id),
				}),
			)
				.then((usage) => this.settle(record.id, usage))
				.catch(() => this.settle(record.id, record.usage, true));
		}
	}
}
