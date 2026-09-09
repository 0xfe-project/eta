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
}

export interface SubagentBus {
	emit(type: "subagents:completed" | "subagents:failed", payload: { id: string; parentId: string | undefined }): void;
}

/** Injected executor: the real one runs a second harness lane over pi-ai. */
export type SubagentRunner = (record: SubagentRecord, api: SubagentApi) => Promise<SubagentUsage>;

export interface SubagentApi {
	reportTurn(recordId: string): void;
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

	private finish(record: SubagentRecord, status: SubagentStatus, usage: SubagentUsage): void {
		record.status = status;
		record.usage = usage;
		record.totalUsage = { input: record.totalUsage.input + usage.input, output: record.totalUsage.output + usage.output };
		let node: SubagentRecord | undefined = record;
		while (node !== undefined) {
			const parent: SubagentRecord | undefined = node.parentId === undefined ? undefined : this.records.get(node.parentId);
			if (parent === undefined) break;
			parent.totalUsage = {
				input: parent.totalUsage.input + node.totalUsage.input,
				output: parent.totalUsage.output + node.totalUsage.output,
			};
			node = parent;
		}
		this.bus.emit(status === "done" ? "subagents:completed" : "subagents:failed", { id: record.id, parentId: record.parentId });
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
			void Promise.resolve(this.runner(record, { reportTurn: (id) => this.reportTurn(id) }))
				.then((usage) => this.settle(record.id, usage))
				.catch(() => this.settle(record.id, record.usage, true));
		}
	}
}
