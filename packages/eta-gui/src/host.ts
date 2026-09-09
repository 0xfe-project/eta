/**
 * The bun-side host: owns the agents, funnels their three channels to
 * subscribers, and holds the single GUI attach pointer. N sessions run
 * concurrently; loops and goals keep firing whether or not a window is open,
 * and closing the GUI never stops the core.
 */

import { BACKGROUND_CONTEXT, EtaAgent, type HarnessEvent, type SessionView } from "@eta/core";
import { SessionViewProjector } from "@eta/core";
import { DevRing, type ChannelFrame, type DevFrame } from "./channels.ts";
import type { SidebarSession } from "./fake.ts";

const AGENT_EVENT_TYPES = [
	"run_start",
	"run_end",
	"run_suspend",
	"run_resume",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"queue_update",
	"usage",
	"retry_start",
	"retry_scheduled",
	"retry_end",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"config_update",
	"value_update",
	"fault",
	"operation_abort",
	"handler_error",
] as const;

export type AnswerFn = (questionId: string, response: Parameters<EtaAgent["ask"]["answer"]>[1]) => boolean;

interface Hosted {
	agent: EtaAgent;
	projector: SessionViewProjector;
	ring: DevRing;
	view: SessionView;
	running: boolean;
	detach(): void;
}

export class Host {
	private readonly hosted = new Map<string, Hosted>();
	private readonly listeners = new Set<(frame: ChannelFrame) => void>();
	private attachPointerValue: string | null = null;

	get attachPointer(): string | null {
		return this.attachPointerValue;
	}

	focus(name: string): void {
		this.attachPointerValue = name;
	}

	async open(name: string, create: () => Promise<EtaAgent>): Promise<void> {
		const agent = await create();
		const projector = new SessionViewProjector(agent);
		const entry: Hosted = {
			agent,
			projector,
			ring: new DevRing(),
			view: await projector.snapshot(BACKGROUND_CONTEXT),
			running: false,
			detach: () => {},
		};
		this.hosted.set(name, entry);
		for (const type of AGENT_EVENT_TYPES) {
			agent.harness.events.on(type, (event: HarnessEvent) => {
				if (type === "run_start") entry.running = true;
				if (type === "run_end") entry.running = false;
				this.emit({ channel: "agent", event });
			});
		}
		agent.events.on("eta", (event) => {
			const frame: DevFrame = { ts: Date.now(), session: name, category: event.category, action: event.action, data: event.data };
			entry.ring.push(frame);
			this.emit({ channel: "dev", frame });
		});
		const attached = await projector.attach((view) => {
			entry.view = view;
			this.emit({ channel: "view", view });
		}, BACKGROUND_CONTEXT);
		entry.detach = attached.detach;
		this.attachPointerValue ??= name;
	}

	sidebar(): SidebarSession[] {
		return [...this.hosted.entries()].map(([name, entry]) => ({
			name,
			badges: [
				...(entry.running ? ["running"] : []),
				...(entry.view.goal?.status === "active" ? ["goal"] : []),
				...(entry.view.pendingAsk === undefined ? [] : ["ask-pending"]),
				...(entry.view.loops.length > 0 ? ["loop"] : []),
			],
		}));
	}

	agentOf(name: string): EtaAgent | undefined {
		return this.hosted.get(name)?.agent;
	}

	viewOf(name: string): SessionView | undefined {
		return this.hosted.get(name)?.view;
	}

	ringOf(name: string): DevRing | undefined {
		return this.hosted.get(name)?.ring;
	}

	askOf(name: string): { answer: AnswerFn } | undefined {
		const entry = this.hosted.get(name);
		return entry === undefined ? undefined : { answer: (id, response) => entry.agent.ask.answer(id, response) };
	}

	goal(name: string, action: "set" | "pause" | "resume" | "clear", objective?: string): void {
		const agent = this.must(name);
		if (action === "set" && objective !== undefined) agent.goal.set(objective);
		if (action === "pause") agent.goal.pause();
		if (action === "resume") agent.goal.resume();
		if (action === "clear") agent.goal.clear();
	}

	loopToggle(name: string, id: string, paused: boolean): void {
		this.must(name).loops.pause(id, paused);
	}

	taskSet(name: string, id: string, status: "pending" | "in_progress" | "completed" | "cancelled"): void {
		this.must(name).setTask(id, { status });
	}

	async compact(name: string): Promise<void> {
		await this.must(name).lane.compact(undefined, BACKGROUND_CONTEXT);
	}

	async abort(name: string): Promise<void> {
		await this.must(name).lane.abort(BACKGROUND_CONTEXT);
	}

	private must(name: string): EtaAgent {
		const entry = this.hosted.get(name);
		if (entry === undefined) throw new Error(`no session ${name}`);
		return entry.agent;
	}

	async prompt(name: string, text: string): Promise<void> {
		const entry = this.hosted.get(name);
		if (entry === undefined) throw new Error(`no session ${name}`);
		this.attachPointerValue = name;
		await entry.agent.lane.prompt(text, undefined, BACKGROUND_CONTEXT);
	}

	subscribe(listener: (frame: ChannelFrame) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {
		for (const entry of this.hosted.values()) {
			entry.detach();
			await entry.agent.harness.close(BACKGROUND_CONTEXT);
		}
		this.hosted.clear();
	}

	private emit(frame: ChannelFrame): void {
		for (const listener of [...this.listeners]) listener(frame);
	}
}
