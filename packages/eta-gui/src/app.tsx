/**
 * The GUI. It sees exactly three channels and speaks back only through GuiOps;
 * no core internals beyond the frame types. Blocks: sidebar | timeline |
 * Context/Dev tabs | composer, plus the ask modal.
 */

import { useState } from "react";
import type { SessionView } from "@eta/core";
import type { DevFrame } from "./channels.ts";
import type { SidebarSession } from "./fake.ts";

export interface AskAnswer {
	kind: "selection" | "freeform" | "none";
	selections?: string[];
	text?: string;
}

export interface GuiOps {
	focus(name: string): void;
	prompt(text: string): void;
	goal(action: "set" | "pause" | "resume" | "clear", objective?: string): void;
	loopToggle(id: string, paused: boolean): void;
	compact(): void;
	abort(): void;
	answer(questionId: string, response: AskAnswer): void;
}

export const noOps: GuiOps = {
	focus: () => {},
	prompt: () => {},
	goal: () => {},
	loopToggle: () => {},
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
	"ask-pending": "#a6e3a1",
};

const textOf = (message: unknown): string => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as { type?: string; text?: string }[])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}
	return "";
};

const BUTTON = { padding: 6, borderWidth: 1, borderColor: PANEL, fontSize: 12, color: TEXT } as const;

export function EtaApp({ sessions, active, view, dev, ops, defaultTab = "dev" }: EtaAppProps) {
	const [tab, setTab] = useState<"context" | "dev">(defaultTab);
	const [filter, setFilter] = useState("");
	const [draft, setDraft] = useState("");
	const needle = filter.trim().toLowerCase();
	const rows = dev.filter(
		(f) => needle === "" || f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle),
	);
	const timeline = [
		...view.messages.map((m) => ({ seq: m.seq, el: m })),
		...view.systems.map((s) => ({ seq: s.seq, el: s })),
	].sort((a, b) => a.seq - b.seq);
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
				<div style={{ flexGrow: 1, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
					{timeline.map((row) =>
						"entryId" in row.el && "kind" in row.el ? (
							<div key={row.el.entryId} style={{ fontSize: 12, color: CATEGORY_COLORS[row.el.kind === "ask" ? "ask_user" : row.el.kind === "goal" ? "goal" : row.el.kind] ?? DIM }}>
								{row.el.text}
							</div>
						) : (
							<div key={(row.el as { entryId: string }).entryId} style={{ fontSize: 14 }}>
								{`${(row.el as { message: { role?: string } }).message.role === "user" ? "you" : "eta"}: ${textOf((row.el as { message: unknown }).message)}`}
							</div>
						),
					)}
				</div>
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
					<div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
						<div>usage in {view.usage.input} / out {view.usage.output} / cache {(view.cacheRate * 100).toFixed(0)}% · epoch {view.compactionEpoch}</div>
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
							<div key={task.id} style={{ color: task.status === "completed" ? DIM : TEXT }}>
								[{task.status}] {task.content}
							</div>
						))}
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
						{view.subagents.map((subagent) => (
							<div key={subagent.id}>
								agent {subagent.id} · {subagent.status} · turns {subagent.turns}
							</div>
						))}
						<div style={{ display: "flex", flexDirection: "row", gap: 6 }}>
							<div testId="compact" onClick={ops.compact} style={BUTTON}>
								compact
							</div>
						</div>
					</div>
				) : (
					<div style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
						<input testId="dev-filter" value={filter} placeholder="filter" onChange={(event) => setFilter(event.value ?? "")} style={{ marginBottom: 8, fontSize: 12, color: DIM }} />
						{rows.map((frame, index) => (
							<div key={`${frame.ts}-${index}`} style={{ paddingTop: 2, paddingBottom: 2, paddingLeft: 12, paddingRight: 12, fontSize: 12 }}>
								<div style={{ color: CATEGORY_COLORS[frame.category] ?? DIM }}>{`${frame.category} · ${frame.action}`}</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
