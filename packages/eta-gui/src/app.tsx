/**
 * The GUI. It sees exactly three channels and speaks back only through GuiOps;
 * no core internals beyond the frame types. Blocks: sidebar | timeline |
 * Context/Dev tabs | composer, plus the ask modal.
 */

import { useRef, useState } from "react";
import type { SessionView, SessionViewMessage } from "@eta/core";
import type { DevFrame } from "./channels.ts";
import type { SidebarSession } from "./fake.ts";

export interface AskAnswer {
	kind: "selection" | "freeform" | "none";
	selections?: string[];
	text?: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface GuiOps {
	focus(name: string): void;
	prompt(text: string): void;
	goal(action: "set" | "pause" | "resume" | "clear", objective?: string): void;
	loopToggle(id: string, paused: boolean): void;
	taskSet(id: string, status: TaskStatus): void;
	btwOpen(kind: "contextual" | "tangent"): void;
	btwAnswer(threadId: string, question: string, answer: string): void;
	btwSave(threadId: string): void;
	btwClear(threadId: string): void;
	stateDelete(key: string): void;
	subagentStop(id: string): void;
	compact(): void;
	abort(): void;
	answer(questionId: string, response: AskAnswer): void;
}

export const noOps: GuiOps = {
	focus: () => {},
	prompt: () => {},
	goal: () => {},
	loopToggle: () => {},
	taskSet: () => {},
	btwOpen: () => {},
	btwAnswer: () => {},
	btwSave: () => {},
	btwClear: () => {},
	stateDelete: () => {},
	subagentStop: () => {},
	compact: () => {},
	abort: () => {},
	answer: () => {},
};

export interface EtaAppProps {
	sessions: SidebarSession[];
	active: string;
	view: SessionView;
	dev: DevFrame[];
	ops: GuiOps;
	running?: boolean;
	defaultTab?: "context" | "dev";
}

const BG = "#1e1e2e";
const PANEL = "#181825";
const TEXT = "#cdd6f4";
const DIM = "#a6adc8";

const CATEGORY_COLORS: Record<string, string> = {
	lifecycle: "#89b4fa",
	turn: "#89b4fa",
	usage: "#a6e3a1",
	prompt: "#94e2d5",
	compaction: "#fab387",
	loop: "#f9e2af",
	goal: "#f38ba8",
	memory: "#94e2d5",
	skill: "#cba6f7",
	todo: "#f9e2af",
	state: "#b4befe",
	tool: "#fab387",
	retry: "#f38ba8",
	ask_user: "#a6e3a1",
	btw: "#cba6f7",
	running: "#89b4fa",
	"ask-pending": "#a6adc8",
};

const SYSTEM_KIND_CATEGORY: Record<string, string> = { goal: "goal", ask: "ask_user", btw: "btw", compaction: "compaction", merge: "lifecycle" };

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
	pending: "in_progress",
	in_progress: "completed",
	completed: "cancelled",
	cancelled: "pending",
};

interface Block {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

const blocksOf = (message: unknown): Block[] => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as Block[];
	return [];
};

const resultText = (message: unknown): string => {
	const content = (message as { content?: unknown }).content;
	if (Array.isArray(content)) {
		return (content as { type?: string; text?: string }[])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
	}
	return "";
};

const roleLabel = (message: SessionViewMessage["message"]): string => {
	const role = (message as { role?: string }).role ?? "";
	return role === "user" ? "you" : role === "toolResult" ? "tool" : "eta";
};

const BUTTON = { padding: 6, borderWidth: 1, borderColor: PANEL, fontSize: 12, color: TEXT } as const;

const TRANSIENT_ACTIONS: Record<string, string[]> = {
	loop: ["fired", "paused", "expired", "suppressed"],
	retry: [],
};

function TimelineRow({ row }: { row: { el: unknown } }) {
	const el = row.el as { entryId?: string; seq?: number; frame?: DevFrame };
	if (el.frame !== undefined) {
		const frame = el.frame;
		return (
			<div testId={`event-${frame.category}-${frame.action}`} style={{ fontSize: 12, color: CATEGORY_COLORS[frame.category] ?? DIM }}>
				{`${frame.category} · ${frame.action}`}
			</div>
		);
	}
	if (el.entryId !== undefined && el.seq !== undefined && "kind" in el && typeof (el as { kind?: unknown }).kind === "string" && !("message" in el)) {
		const system = el as unknown as { entryId: string; kind: string; text: string };
		return (
			<div testId={`system-${system.entryId}`} style={{ fontSize: 12, color: CATEGORY_COLORS[SYSTEM_KIND_CATEGORY[system.kind]] ?? DIM }}>
				{system.text}
			</div>
		);
	}
	const entry = el as unknown as SessionViewMessage;
	const role = (entry.message as { role?: string }).role ?? "";
	if (role === "toolResult") {
		const toolName = (entry.message as { toolName?: string }).toolName ?? "tool";
		return (
			<div key={entry.entryId} testId={`tool-result-${(entry.message as { toolCallId?: string }).toolCallId ?? entry.entryId}`}>
				<div style={{ fontSize: 12, color: CATEGORY_COLORS.tool }}>{`↳ ${toolName}`}</div>
				<code code={resultText(entry.message)} language="text" style={{ fontSize: 12, color: DIM }} />
			</div>
		);
	}
	const blocks = blocksOf(entry.message);
	const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
	const calls = blocks.filter((b) => b.type === "toolCall");
	return (
		<div key={entry.entryId} testId={`msg-${entry.entryId}`} style={{ fontSize: 14 }}>
			<div style={{ color: DIM }}>{roleLabel(entry.message)}</div>
			{texts === "" ? null : <markdown source={texts} style={{ fontSize: 14, color: TEXT }} />}
			{calls.map((call) => (
				<div key={call.id} testId={`tool-${call.id}`} style={{ marginTop: 4 }}>
					<div style={{ fontSize: 12, color: CATEGORY_COLORS.tool }}>{`⚙ ${call.name}`}</div>
					<code code={JSON.stringify(call.arguments ?? {})} language="json" style={{ fontSize: 12, color: DIM }} />
				</div>
			))}
		</div>
	);
}

export function EtaApp({ sessions, active, view, dev, ops, running = false, defaultTab = "dev" }: EtaAppProps) {
	const [tab, setTab] = useState<"context" | "dev">(defaultTab);
	const [filter, setFilter] = useState("");
	const [draft, setDraft] = useState("");
	const needle = filter.trim().toLowerCase();
	const filtered = dev.filter(
		(f) => needle === "" || f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle),
	);
	const [devPaused, setDevPaused] = useState(false);
	const frozen = useRef(filtered);
	if (!devPaused) frozen.current = filtered;
	const rows = frozen.current;
	const transient = dev.filter((f) => (TRANSIENT_ACTIONS[f.category]?.includes(f.action) ?? false) || f.category === "retry");
	const timeline: { seq: number; el: unknown }[] = [
		...view.messages.map((m) => ({ seq: m.seq, el: m })),
		...view.systems.map((s) => ({ seq: s.seq, el: s })),
	];
	timeline.sort((a, b) => a.seq - b.seq);
	for (const frame of transient) timeline.push({ seq: Number.MAX_SAFE_INTEGER, el: { frame } });
	const send = () => {
		const text = draft.trim();
		if (text !== "") ops.prompt(text);
		setDraft("");
	};
	return (
		<div style={{ display: "flex", flexDirection: "row", width: 1280, height: 800, backgroundColor: BG, color: TEXT }}>
			<div style={{ width: 200, backgroundColor: PANEL, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ fontSize: 12, color: DIM }}>sessions</div>
				{sessions.map((session) => (
					<div
						key={session.name}
						testId={`session-${session.name}`}
						onClick={() => ops.focus(session.name)}
						style={{
							display: "flex",
							flexDirection: "row",
							gap: 6,
							padding: 4,
							backgroundColor: session.name === active ? BG : undefined,
						}}
					>
						<div style={{ fontSize: 14 }}>{session.name}</div>
						{session.badges.map((badge) => (
							<div key={badge} style={{ color: CATEGORY_COLORS[badge] ?? DIM, fontSize: 12 }}>
								{badge}
							</div>
						))}
					</div>
				))}
				<div style={{ color: DIM, fontSize: 12, paddingTop: 24 }}>archive</div>
			</div>
			<div style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
				<virtual-list followTail estimatedItemHeight={32} style={{ flexGrow: 1, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
					{timeline.map((row) => (
						<TimelineRow key={`row-${(row.el as { entryId?: string; frame?: DevFrame }).entryId ?? `${(row.el as { frame?: DevFrame }).frame?.ts}`}`} row={row} />
					))}
					{view.thinking.slice(-1).map((thought, index) => (
						<div key={`thinking-${index}`} testId="thinking-row" style={{ fontSize: 12, color: DIM }}>
							{`… ${thought.slice(0, 80)}`}
						</div>
					))}
				</virtual-list>
				{view.pendingAsk === undefined ? null : (
					<div testId="ask-modal" style={{ borderWidth: 1, borderColor: CATEGORY_COLORS.ask_user, padding: 12, margin: 12, backgroundColor: PANEL }}>
						<div style={{ fontSize: 14 }}>{view.pendingAsk.question}</div>
						{(view.pendingAsk.options ?? []).map((option) => (
							<div
								key={option}
								testId={`ask-option-${option}`}
								onClick={() => ops.answer(view.pendingAsk!.questionId, { kind: "selection", selections: [option] })}
								style={{ ...BUTTON, marginTop: 6 }}
							>
								{option}
							</div>
						))}
						<div testId="ask-decline" onClick={() => ops.answer(view.pendingAsk!.questionId, { kind: "none" })} style={{ ...BUTTON, marginTop: 6, color: DIM }}>
							decline
						</div>
					</div>
				)}
				<div style={{ height: 64, borderTopWidth: 1, borderColor: PANEL, display: "flex", flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 12, gap: 8 }}>
					<input
						testId="composer"
						value={draft}
						placeholder="ask eta anything…"
						onChange={(event) => setDraft(event.value ?? "")}
						onSubmit={send}
						style={{ flexGrow: 1, fontSize: 14, color: TEXT }}
					/>
					{running ? (
						<div testId="queued-bar" style={{ color: DIM, fontSize: 12 }}>
							run in progress — next message lands at the turn boundary
						</div>
					) : null}
					<div testId="abort" onClick={ops.abort} style={{ color: DIM, fontSize: 12 }}>
						abort
					</div>
				</div>
			</div>
			<div style={{ width: 340, backgroundColor: PANEL, display: "flex", flexDirection: "column" }}>
				<div style={{ display: "flex", gap: 12, padding: 12 }}>
					<div testId="tab-context" style={{ fontSize: 13, color: tab === "context" ? TEXT : DIM }} onClick={() => setTab("context")}>
						Context
					</div>
					<div testId="tab-dev" style={{ fontSize: 13, color: tab === "dev" ? TEXT : DIM }} onClick={() => setTab("dev")}>
						Dev
					</div>
				</div>
				{tab === "context" ? (
					<div style={{ flexGrow: 1, padding: 12, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
						<div testId="usage-row">usage in {view.usage.input} / out {view.usage.output} / cache {(view.cacheRate * 100).toFixed(0)}% · epoch {view.compactionEpoch} · {Math.round(view.tokensPerSec)} tok/s</div>
						<div testId="prompt-row">{view.prompt === undefined ? "prompt not assembled yet" : `prompt ${view.prompt.stableChars} stable / ${view.prompt.adaptiveChars} adaptive`}</div>
						<div testId="goal-card" style={{ borderWidth: 1, borderColor: CATEGORY_COLORS.goal, padding: 8 }}>
							<div>{view.goal === undefined ? "no goal" : `goal: ${view.goal.objective} (${view.goal.status})`}</div>
							<div style={{ display: "flex", flexDirection: "row", gap: 6, marginTop: 6 }}>
								<div testId="goal-pause" onClick={() => ops.goal("pause")} style={BUTTON}>
									pause
								</div>
								<div testId="goal-resume" onClick={() => ops.goal("resume")} style={BUTTON}>
									resume
								</div>
								<div testId="goal-clear" onClick={() => ops.goal("clear")} style={BUTTON}>
									clear
								</div>
							</div>
						</div>
						{view.tasks.map((task) => (
							<div
								key={task.id}
								testId={`task-${task.id}`}
								onClick={() => ops.taskSet(task.id, NEXT_STATUS[task.status as TaskStatus] ?? "pending")}
								style={{ color: task.status === "completed" ? DIM : TEXT }}
							>
								[{task.status}] {task.content}
							</div>
						))}
						{view.subagents.map((subagent) => (
							<div key={subagent.id} testId={`fleet-${subagent.id}`} style={{ display: "flex", flexDirection: "row", gap: 6 }}>
								<div>{`agent ${subagent.id} · ${subagent.status} · turns ${subagent.turns}`}</div>
								<div testId={`fleet-stop-${subagent.id}`} onClick={() => ops.subagentStop(subagent.id)} style={BUTTON}>
									stop
								</div>
							</div>
						))}
						{view.stateKeys.map((key) => (
							<div key={key} testId={`state-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`} style={{ display: "flex", flexDirection: "row", gap: 6 }}>
								<div>{`kv ${key}`}</div>
								<div testId={`state-delete-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`} onClick={() => ops.stateDelete(key)} style={BUTTON}>
									delete
								</div>
							</div>
						))}
						{view.sideThread.map((thread) => (
							<div key={thread.id} testId={`sideThread-${thread.id}`} style={{ color: CATEGORY_COLORS.btw, display: "flex", flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
								<div>{`btw ${thread.id} · ${thread.exchanges.length}x · ${thread.saveState}`}</div>
								<div testId={`btw-save-${thread.id}`} onClick={() => ops.btwSave(thread.id)} style={BUTTON}>
									save
								</div>
								<div testId={`btw-clear-${thread.id}`} onClick={() => ops.btwClear(thread.id)} style={BUTTON}>
									clear
								</div>
							</div>
						))}
						<div testId="btw-new" onClick={() => ops.btwOpen("tangent")} style={{ ...BUTTON, alignSelf: "flex-start" }}>
							new btw
						</div>
						<div testId="compact" onClick={ops.compact} style={{ ...BUTTON, alignSelf: "flex-start" }}>
							compact
						</div>
						{view.loops.map((loop) => (
							<div key={loop.id} testId={`loop-${loop.id}`} onClick={() => ops.loopToggle(loop.id, !loop.paused)} style={{ color: loop.paused ? DIM : CATEGORY_COLORS.loop }}>
								loop {loop.id} · {loop.note} · {loop.paused ? "paused" : "on"} · fired {loop.runCount}
							</div>
						))}
						{view.memory === undefined ? null : (
							<div>
								memory {view.memory.chars}/20000
								<div style={{ height: 4, backgroundColor: BG, width: 200 }}>
									<div style={{ height: 4, width: Math.min(200, (view.memory.chars / 20000) * 200), backgroundColor: CATEGORY_COLORS.memory }} />
								</div>
							</div>
						)}
						{view.sideThread.map((thread) => (
							<input
								key={`answer-${thread.id}`}
								testId={`btw-answer-${thread.id}`}
								placeholder="inject a note…"
								onSubmit={(event) => {
									const text = (event.value ?? "").trim();
									if (text !== "") ops.btwAnswer(thread.id, "from the panel", text);
								}}
								style={{ fontSize: 12, color: DIM, borderWidth: 1, borderColor: BG }}
							/>
						))}
					</div>
				) : (
					<div style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
						<div style={{ display: "flex", flexDirection: "row", gap: 8 }}>
							<input testId="dev-filter" value={filter} placeholder="filter" onChange={(event) => setFilter(event.value ?? "")} style={{ flexGrow: 1, marginBottom: 8, fontSize: 12, color: DIM }} />
							<div testId="dev-pause" onClick={() => setDevPaused((p) => !p)} style={{ ...BUTTON, fontSize: 12 }}>
								{devPaused ? "resume" : "pause"}
							</div>
						</div>
						<virtual-list followTail estimatedItemHeight={18} style={{ flexGrow: 1 }}>
							{rows.map((frame, index) => (
								<div key={`${frame.ts}-${index}`} style={{ paddingTop: 2, paddingBottom: 2, paddingLeft: 12, paddingRight: 12, fontSize: 12 }}>
									<div style={{ color: CATEGORY_COLORS[frame.category] ?? DIM }}>{`${frame.category} · ${frame.action}`}</div>
								</div>
							))}
						</virtual-list>
					</div>
				)}
			</div>
		</div>
	);
}
