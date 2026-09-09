/**
 * The GUI. It sees exactly three channels and speaks back only through GuiOps;
 * no core internals beyond the frame types. Blocks: sidebar | timeline |
 * Context/Dev tabs | composer, plus the ask modal. Visual language follows
 * the gpuix chat example: graphite surfaces, hairline borders, one accent.
 */

import { useEffect, useRef, useState } from "react";
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
	files?: string[];
	defaultTab?: "context" | "dev";
}

const C = {
	canvas: "#1A1A1A",
	sidebar: "#161616",
	raised: "#232323",
	composer: "#212121",
	item: "#F0F0F00F",
	overlay: "#E6EAF20D",
	overlayStrong: "#E6EAF217",
	border: "#E6EAF212",
	borderStrong: "#E6EAF224",
	text: "#E2E2E2",
	secondary: "#A3A3A3",
	tertiary: "#7D7D7D",
	accent: "#E2795B",
	code: "#E0A882",
};

const MONO = "Menlo";

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
	"ask-pending": "#A3A3A3",
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

const BUTTON = {
	paddingTop: 5,
	paddingBottom: 5,
	paddingLeft: 9,
	paddingRight: 9,
	borderRadius: 7,
	backgroundColor: C.item,
	hover: { backgroundColor: C.overlayStrong },
	fontSize: 12,
	color: C.secondary,
} as const;

const LABEL = { fontSize: 11, fontWeight: 600, color: C.tertiary } as const;

const CARD = {
	backgroundColor: C.raised,
	borderRadius: 10,
	borderWidth: 1,
	borderColor: C.border,
	padding: 10,
} as const;

const TRANSIENT_ACTIONS: Record<string, string[]> = {
	loop: ["fired", "paused", "expired", "suppressed"],
	retry: [],
};

function TimelineRow({ row }: { row: { el: unknown } }) {
	const el = row.el as { entryId?: string; seq?: number; frame?: DevFrame };
	if (el.frame !== undefined) {
		const frame = el.frame;
		return (
			<div testId={`event-${frame.category}-${frame.action}`} style={{ alignSelf: "center", backgroundColor: C.item, borderRadius: 8, paddingTop: 3, paddingBottom: 3, paddingLeft: 10, paddingRight: 10, fontSize: 11.5, color: CATEGORY_COLORS[frame.category] ?? C.secondary }}>
				{`${frame.category} · ${frame.action}`}
			</div>
		);
	}
	if (el.entryId !== undefined && el.seq !== undefined && "kind" in el && typeof (el as { kind?: unknown }).kind === "string" && !("message" in el)) {
		const system = el as unknown as { entryId: string; kind: string; text: string };
		return (
			<div testId={`system-${system.entryId}`} style={{ alignSelf: "center", backgroundColor: C.item, borderRadius: 8, paddingTop: 3, paddingBottom: 3, paddingLeft: 10, paddingRight: 10, fontSize: 11.5, color: CATEGORY_COLORS[SYSTEM_KIND_CATEGORY[system.kind]] ?? C.secondary }}>
				{system.text}
			</div>
		);
	}
	const entry = el as unknown as SessionViewMessage;
	const role = (entry.message as { role?: string }).role ?? "";
	if (role === "toolResult") {
		const toolName = (entry.message as { toolName?: string }).toolName ?? "tool";
		return (
			<div key={entry.entryId} testId={`tool-result-${(entry.message as { toolCallId?: string }).toolCallId ?? entry.entryId}`} style={{ maxWidth: 720 }}>
				<div style={{ fontSize: 11, fontWeight: 600, color: C.tertiary }}>{`↳ ${toolName}`}</div>
				<code code={resultText(entry.message)} language="text" style={{ fontFamily: MONO, fontSize: 12, color: C.secondary, backgroundColor: C.overlay, borderRadius: 8, padding: 8 }} />
			</div>
		);
	}
	const blocks = blocksOf(entry.message);
	const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
	const calls = blocks.filter((b) => b.type === "toolCall");
	const isUser = role === "user";
	return (
		<div
			key={entry.entryId}
			testId={`msg-${entry.entryId}`}
			style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 640, alignSelf: isUser ? "flex-end" : "flex-start", backgroundColor: isUser ? C.raised : undefined, borderRadius: isUser ? 12 : undefined, paddingTop: isUser ? 8 : 0, paddingBottom: isUser ? 8 : 0, paddingLeft: isUser ? 12 : 0, paddingRight: isUser ? 12 : 0 }}
		>
			<div style={{ fontSize: 11, fontWeight: 600, color: isUser ? C.tertiary : C.accent }}>{roleLabel(entry.message)}</div>
			{texts === "" ? null : <markdown source={texts} style={{ fontSize: 14, lineHeight: 20, color: C.text }} />}
			{calls.map((call) => (
				<div key={call.id} testId={`tool-${call.id}`} style={{ marginTop: 2, backgroundColor: C.overlay, borderLeftWidth: 2, borderColor: C.accent, borderRadius: 8, padding: 8 }}>
					<div style={{ fontSize: 12, fontWeight: 600, color: CATEGORY_COLORS.tool }}>{`⚙ ${call.name}`}</div>
					<code code={JSON.stringify(call.arguments ?? {})} language="json" style={{ fontFamily: MONO, fontSize: 12, color: C.code }} />
				</div>
			))}
		</div>
	);
}

export function EtaApp({ sessions, active, view, dev, ops, running = false, files = [], defaultTab = "dev" }: EtaAppProps) {
	const [tab, setTab] = useState<"context" | "dev">(defaultTab);
	const [filter, setFilter] = useState("");
	const [draft, setDraft] = useState("");
	const [picked, setPicked] = useState<string[]>([]);
	const [reply, setReply] = useState("");
	const [now, setNow] = useState(() => Date.now());
	const deadline = view.pendingAskDeadline;
	useEffect(() => {
		if (deadline === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [deadline]);
	const mentionMatch = /(?:^|\s)@([\w./-]*)$/.exec(draft);
	const mentions = mentionMatch === null ? [] : files.filter((f) => f.toLowerCase().includes((mentionMatch[1] ?? "").toLowerCase())).slice(0, 5);
	const pickMention = (file: string) => {
		const token = `@${mentionMatch?.[1] ?? ""}`;
		setDraft(`${draft.slice(0, draft.length - token.length)}${file} `);
	};
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
		<div style={{ display: "flex", flexDirection: "row", width: 1280, height: 800, backgroundColor: C.canvas, color: C.text }}>
			<div style={{ width: 252, backgroundColor: C.sidebar, paddingTop: 18, paddingLeft: 14, paddingRight: 14, display: "flex", flexDirection: "column", gap: 4, borderRightWidth: 1, borderColor: C.border }}>
				<div style={{ fontSize: 15, fontWeight: 700, color: C.accent, marginBottom: 10 }}>eta</div>
				<div style={{ ...LABEL, marginBottom: 4 }}>sessions</div>
				{sessions.map((session) => (
					<div
						key={session.name}
						testId={`session-${session.name}`}
						onClick={() => ops.focus(session.name)}
						style={{
							display: "flex",
							flexDirection: "row",
							alignItems: "center",
							gap: 6,
							paddingTop: 7,
							paddingBottom: 7,
							paddingLeft: 9,
							paddingRight: 9,
							borderRadius: 8,
							backgroundColor: session.name === active ? C.raised : undefined,
							hover: { backgroundColor: C.overlay },
						}}
					>
						<div style={{ fontSize: 13.5, fontWeight: session.name === active ? 600 : 400, color: C.text }}>{session.name}</div>
						{session.badges.map((badge) => (
							<div key={badge} style={{ color: CATEGORY_COLORS[badge] ?? C.secondary, fontSize: 10.5, backgroundColor: C.item, borderRadius: 6, paddingTop: 2, paddingBottom: 2, paddingLeft: 6, paddingRight: 6 }}>
								{badge}
							</div>
						))}
					</div>
				))}
				<div style={{ ...LABEL, marginTop: 20 }}>archive</div>
			</div>
			<div style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
				<virtual-list followTail estimatedItemHeight={32} style={{ flexGrow: 1, paddingTop: 20, paddingBottom: 12, paddingLeft: 24, paddingRight: 24, display: "flex", flexDirection: "column", gap: 10 }}>
					{timeline.map((row) => (
						<TimelineRow key={`row-${(row.el as { entryId?: string; frame?: DevFrame }).entryId ?? `${(row.el as { frame?: DevFrame }).frame?.ts}`}`} row={row} />
					))}
					{view.thinking.slice(-1).map((thought, index) => (
						<div key={`thinking-${index}`} testId="thinking-row" style={{ fontSize: 12, color: C.tertiary }}>
							{`… ${thought.slice(0, 80)}`}
						</div>
					))}
				</virtual-list>
				{view.pendingAsk === undefined ? null : (
					<div testId="ask-modal" style={{ backgroundColor: C.raised, borderRadius: 14, borderWidth: 1, borderColor: C.borderStrong, padding: 14, margin: 16 }}>
						<div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{view.pendingAsk.question}</div>
						{deadline === undefined ? null : (
							<div testId="ask-timeout" style={{ fontSize: 12, color: C.tertiary }}>
								{`${Math.max(0, Math.ceil((deadline - now) / 1000))}s`}
							</div>
						)}
						{(view.pendingAsk.options ?? []).map((option) => (
							<div
								key={option}
								testId={`ask-option-${option}`}
								onClick={() => {
									if (view.pendingAsk === undefined) return;
									const questionId = view.pendingAsk.questionId;
									const multi = view.pendingAsk.multi === true;
									if (multi) {
										setPicked((p) => (p.includes(option) ? p.filter((x) => x !== option) : [...p, option]));
									} else {
										ops.answer(questionId, { kind: "selection", selections: [option] });
									}
								}}
								style={{ ...BUTTON, marginTop: 6, color: C.text, backgroundColor: picked.includes(option) ? "#E2795B33" : C.item }}
							>
								{option}
							</div>
						))}
						{view.pendingAsk.multi === true ? (
							<div testId="ask-confirm" onClick={() => ops.answer(view.pendingAsk!.questionId, { kind: "selection", selections: picked })} style={{ ...BUTTON, marginTop: 6, backgroundColor: C.accent, color: "#17181C" }}>
								confirm
							</div>
						) : null}
						<input
							testId="ask-reply"
							value={reply}
							placeholder="answer in your own words…"
							onChange={(event) => setReply(event.value ?? "")}
							onSubmit={(event) => {
								const text = (event.value ?? reply).trim();
								if (text !== "") ops.answer(view.pendingAsk!.questionId, { kind: "freeform", text });
							}}
							style={{ ...BUTTON, marginTop: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.composer, color: C.text }}
						/>
						<div testId="ask-decline" onClick={() => ops.answer(view.pendingAsk!.questionId, { kind: "none" })} style={{ ...BUTTON, marginTop: 6, backgroundColor: undefined, color: C.tertiary }}>
							decline
						</div>
					</div>
				)}
				<div style={{ minHeight: 72, borderTopWidth: 1, borderColor: C.border, display: "flex", flexDirection: "row", alignItems: "center", paddingLeft: 24, paddingRight: 24, paddingTop: 10, paddingBottom: 10, gap: 10 }}>
					{mentions.length === 0 ? null : (
						<anchored side="top" align="start" style={{ borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.raised, borderRadius: 10, padding: 6 }}>
							{mentions.map((file) => (
								<div key={file} testId={`mention-${file.replace(/[^a-zA-Z0-9_-]/g, "_")}`} onClick={() => pickMention(file)} style={{ ...BUTTON, fontFamily: MONO, fontSize: 12 }}>
									{file}
								</div>
							))}
						</anchored>
					)}
					<textarea
						testId="composer"
						value={draft}
						placeholder="ask eta anything… @ to mention files"
						minRows={1}
						maxRows={4}
						onChange={(event) => setDraft(event.value ?? "")}
						onSubmit={send}
						style={{ flexGrow: 1, fontSize: 14, lineHeight: 20, color: C.text, backgroundColor: C.composer, borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, hover: { borderColor: C.borderStrong } }}
					/>
					{running ? (
						<div testId="queued-bar" style={{ color: C.tertiary, fontSize: 11.5, maxWidth: 180 }}>
							run in progress — next message lands at the turn boundary
						</div>
					) : null}
					<div testId="abort" onClick={ops.abort} style={{ ...BUTTON, color: C.tertiary }}>
						abort
					</div>
				</div>
			</div>
			<div style={{ width: 340, backgroundColor: C.sidebar, borderLeftWidth: 1, borderColor: C.border, display: "flex", flexDirection: "column" }}>
				<div style={{ display: "flex", gap: 16, paddingTop: 18, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: C.border }}>
					<div testId="tab-context" style={{ fontSize: 13, fontWeight: tab === "context" ? 600 : 400, color: tab === "context" ? C.text : C.tertiary }} onClick={() => setTab("context")}>
						Context
					</div>
					<div testId="tab-dev" style={{ fontSize: 13, fontWeight: tab === "dev" ? 600 : 400, color: tab === "dev" ? C.text : C.tertiary }} onClick={() => setTab("dev")}>
						Dev
					</div>
				</div>
				{tab === "context" ? (
					<div style={{ flexGrow: 1, paddingTop: 12, paddingLeft: 12, paddingRight: 12, paddingBottom: 12, display: "flex", flexDirection: "column", gap: 7, fontSize: 13 }}>
						<div testId="usage-row" style={{ fontFamily: MONO, fontSize: 11.5, color: C.secondary }}>{`usage in ${view.usage.input} / out ${view.usage.output} / cache ${(view.cacheRate * 100).toFixed(0)}% · epoch ${view.compactionEpoch} · ${Math.round(view.tokensPerSec)} tok/s`}</div>
						<div testId="prompt-row" style={{ fontFamily: MONO, fontSize: 11.5, color: C.tertiary }}>{view.prompt === undefined ? "prompt not assembled yet" : `prompt ${view.prompt.stableChars} stable / ${view.prompt.adaptiveChars} adaptive`}</div>
						<div testId="goal-card" style={{ ...CARD, borderLeftWidth: 2, borderColor: CATEGORY_COLORS.goal }}>
							<div style={{ fontSize: 13, color: C.text }}>{view.goal === undefined ? "no goal" : `goal: ${view.goal.objective} (${view.goal.status})`}</div>
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
								style={{ paddingLeft: 2, fontSize: 13, color: task.status === "completed" ? C.tertiary : C.text, hover: { color: C.accent } }}
							>
								[{task.status}] {task.content}
							</div>
						))}
						{view.subagents.map((subagent) => (
							<div key={subagent.id} testId={`fleet-${subagent.id}`} style={{ ...CARD, display: "flex", flexDirection: "row", alignItems: "center", gap: 6, padding: 8 }}>
								<div style={{ fontSize: 12.5, color: C.secondary }}>{`agent ${subagent.id} · ${subagent.status} · turns ${subagent.turns}`}</div>
								<div testId={`fleet-stop-${subagent.id}`} onClick={() => ops.subagentStop(subagent.id)} style={BUTTON}>
									stop
								</div>
							</div>
						))}
						{view.stateKeys.map((key) => (
							<div key={key} testId={`state-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 2 }}>
								<div style={{ fontFamily: MONO, fontSize: 12, color: C.secondary }}>{`kv ${key}`}</div>
								<div testId={`state-delete-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`} onClick={() => ops.stateDelete(key)} style={BUTTON}>
									delete
								</div>
							</div>
						))}
						{view.sideThread.map((thread) => (
							<div key={thread.id} testId={`sideThread-${thread.id}`} style={{ color: CATEGORY_COLORS.btw, display: "flex", flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap", paddingLeft: 2 }}>
								<div style={{ fontSize: 12.5 }}>{`btw ${thread.id} · ${thread.exchanges.length}x · ${thread.saveState}`}</div>
								<div testId={`btw-save-${thread.id}`} onClick={() => ops.btwSave(thread.id)} style={BUTTON}>
									save
								</div>
								<div testId={`btw-clear-${thread.id}`} onClick={() => ops.btwClear(thread.id)} style={BUTTON}>
									clear
								</div>
							</div>
						))}
						<div style={{ display: "flex", flexDirection: "row", gap: 6 }}>
							<div testId="btw-new" onClick={() => ops.btwOpen("tangent")} style={BUTTON}>
								new btw
							</div>
							<div testId="compact" onClick={ops.compact} style={BUTTON}>
								compact
							</div>
						</div>
						{view.loops.map((loop) => (
							<div key={loop.id} testId={`loop-${loop.id}`} onClick={() => ops.loopToggle(loop.id, !loop.paused)} style={{ paddingLeft: 2, fontSize: 12.5, color: loop.paused ? C.tertiary : CATEGORY_COLORS.loop }}>
								{`loop ${loop.id} · ${loop.note} · ${loop.paused ? "paused" : "on"} · fired ${loop.runCount}`}
							</div>
						))}
						{view.memory === undefined ? null : (
							<div style={{ paddingLeft: 2 }}>
								<div style={{ fontSize: 12, color: C.secondary }}>{`memory ${view.memory.chars}/20000`}</div>
								<div style={{ height: 4, backgroundColor: C.item, borderRadius: 2, width: 200, marginTop: 3 }}>
									<div style={{ height: 4, borderRadius: 2, width: Math.min(200, (view.memory.chars / 20000) * 200), backgroundColor: C.accent }} />
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
								style={{ fontSize: 12, color: C.text, backgroundColor: C.composer, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}
							/>
						))}
					</div>
				) : (
					<div style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
						<div style={{ display: "flex", flexDirection: "row", gap: 8, paddingTop: 10, paddingLeft: 12, paddingRight: 12 }}>
							<input testId="dev-filter" value={filter} placeholder="filter" onChange={(event) => setFilter(event.value ?? "")} style={{ flexGrow: 1, fontSize: 12, color: C.text, backgroundColor: C.composer, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }} />
							<div testId="dev-pause" onClick={() => setDevPaused((p) => !p)} style={{ ...BUTTON, fontSize: 12 }}>
								{devPaused ? "resume" : "pause"}
							</div>
						</div>
						<virtual-list followTail estimatedItemHeight={20} style={{ flexGrow: 1, paddingTop: 8 }}>
							{rows.map((frame, index) => (
								<div key={`${frame.ts}-${index}`} style={{ paddingTop: 2.5, paddingBottom: 2.5, paddingLeft: 14, paddingRight: 14 }}>
									<div style={{ fontFamily: MONO, fontSize: 11.5, color: CATEGORY_COLORS[frame.category] ?? C.secondary }}>{`${frame.category} · ${frame.action}`}</div>
								</div>
							))}
						</virtual-list>
					</div>
				)}
			</div>
		</div>
	);
}
