/**
 * G0 layout: sidebar | timeline | Context/Dev tabs | composer. Four blocks,
 * fed only by the three channels (SessionView + dev frames). Real data lands
 * at G1; the fake feed already renders the same components.
 */

import { useState } from "react";
import type { SessionView } from "@eta/core";
import type { DevFrame } from "./channels.ts";
import type { SidebarSession } from "./fake.ts";

export interface EtaAppProps {
	sessions: SidebarSession[];
	view: SessionView;
	dev: DevFrame[];
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

export function EtaApp({ sessions, view, dev }: EtaAppProps) {
	const [tab, setTab] = useState<"context" | "dev">("dev");
	const [filter, setFilter] = useState("");
	const needle = filter.trim().toLowerCase();
	const rows = dev.filter(
		(f) => needle === "" || f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle),
	);
	return (
		<div style={{ display: "flex", flexDirection: "row", width: 1280, height: 800, backgroundColor: BG, color: TEXT }}>
			<div style={{ width: 200, backgroundColor: PANEL, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ fontSize: 12, color: DIM }}>sessions</div>
				{sessions.map((session) => (
					<div key={session.name} style={{ display: "flex", flexDirection: "row", gap: 6 }}>
						<div style={{ fontSize: 14 }}>{session.name}</div>
						{session.badges.map((badge) => (
							<div key={badge} style={{ color: CATEGORY_COLORS[badge === "ask-pending" ? "ask_user" : badge === "running" ? "turn" : badge] ?? DIM, fontSize: 12 }}>
								{badge}
							</div>
						))}
					</div>
				))}
				<div style={{ color: DIM, fontSize: 12, paddingTop: 24 }}>archive</div>
			</div>
			<div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
				<div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
					{view.messages.map((row) => (
						<div key={row.entryId} style={{ fontSize: 14 }}>
							{`${(row.message as { role?: string }).role === "user" ? "you" : "eta"}: ${textOf(row.message)}`}
						</div>
					))}
				</div>
				<div style={{ height: 64, borderTopWidth: 1, borderTopColor: PANEL, padding: 12, color: DIM, fontSize: 14 }}>
					ask eta anything…
				</div>
			</div>
			<div style={{ width: 340, backgroundColor: PANEL, display: "flex", flexDirection: "column" }}>
				<div style={{ display: "flex", gap: 12, padding: 12 }}>
					<div style={{ fontSize: 13, color: tab === "context" ? TEXT : DIM, cursor: "pointer" }} onClick={() => setTab("context")}>
						Context
					</div>
					<div style={{ fontSize: 13, color: tab === "dev" ? TEXT : DIM, cursor: "pointer" }} onClick={() => setTab("dev")}>
						Dev
					</div>
				</div>
				{tab === "context" ? (
					<div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
						<div>usage in {view.usage.input} / out {view.usage.output} / cache {(view.cacheRate * 100).toFixed(0)}%</div>
						<div>{view.goal === undefined ? "no goal" : `goal: ${view.goal.objective}`}</div>
						<div>tasks {view.tasks.length} · loops {view.loops.length} · side {view.sideThread.length}</div>
					</div>
				) : (
					<div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
						<div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 8, color: DIM, fontSize: 12 }}>filter</div>
						{rows.map((frame, index) => (
							<div key={`${frame.ts}-${index}`} style={{ paddingTop: 2, paddingBottom: 2, paddingLeft: 12, paddingRight: 12, fontSize: 12 }}>
								<div style={{ color: CATEGORY_COLORS[frame.category] ?? DIM }}>{frame.category}</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
