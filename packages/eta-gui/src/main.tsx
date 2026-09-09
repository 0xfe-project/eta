import { useEffect, useState } from "react";
import { render } from "@gpuix/react";
import { EtaApp, type GuiOps } from "./app.tsx";
import { Host } from "./host.ts";
import type { SidebarSession } from "./fake.ts";
import type { DevFrame, ChannelFrame } from "./channels.ts";
import type { SessionView } from "@eta/core";
import { makeFauxAgent } from "./faux-agent.ts";

export function LiveApp({ host, ready }: { host: Host; ready?: Promise<void> }) {
	const [pointer, setPointer] = useState<string>(host.attachPointer ?? "eta-main");
	const [sessions, setSessions] = useState<SidebarSession[]>(host.sidebar());
	const [view, setView] = useState<SessionView | undefined>(host.viewOf(pointer));
	const [dev, setDev] = useState<DevFrame[]>(host.ringOf(pointer)?.tail() ?? []);

	useEffect(() => {
		let queued = false;
		const refresh = () => {
			if (queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				const next = host.attachPointer ?? "eta-main";
				setPointer(next);
				setSessions(host.sidebar());
				setView(host.viewOf(next));
				setDev(host.ringOf(next)?.tail() ?? []);
			});
		};
		const off = host.subscribe((frame: ChannelFrame) => frame && refresh());
		void (ready ?? Promise.resolve())
			.then(() => host.prompt(host.attachPointer ?? "eta-main", "hello eta"))
			.catch(() => undefined);
		return off;
	}, [host, ready]);

	const ops: GuiOps = {
		focus: (name) => {
			host.focus(name);
			refreshNow();
		},
		prompt: (text) => void host.prompt(pointer, text).catch(() => undefined),
		goal: (action, objective) => host.goal(pointer, action, objective),
		loopToggle: (id, paused) => host.loopToggle(pointer, id, paused),
		taskSet: (id, status) => host.taskSet(pointer, id, status),
		btwOpen: (kind) => host.btwOpen(pointer, kind),
		btwAnswer: (threadId, question, answer) => host.btwAnswer(pointer, threadId, question, answer),
		btwSave: (threadId) => host.btwSave(pointer, threadId),
		btwClear: (threadId) => host.btwClear(pointer, threadId),
		stateDelete: (key) => host.stateSet(pointer, key, null),
		subagentStop: (id) => host.subagentStop(pointer, id),
		compact: () => void host.compact(pointer).catch(() => undefined),
		abort: () => void host.abort(pointer).catch(() => undefined),
		answer: (questionId, response) => host.askOf(pointer)?.answer(questionId, response as Parameters<NonNullable<ReturnType<Host["askOf"]>>["answer"]>[1]),
	};
	const refreshNow = () => {
		setPointer(host.attachPointer ?? "eta-main");
		setSessions(host.sidebar());
		setView(host.viewOf(host.attachPointer ?? "eta-main"));
		setDev(host.ringOf(host.attachPointer ?? "eta-main")?.tail() ?? []);
	};

	if (view === undefined) {
		return <div style={{ width: 1280, height: 800, backgroundColor: "#1e1e2e", color: "#cdd6f4", padding: 24 }}>starting…</div>;
	}
	return (
		<EtaApp
			sessions={sessions}
			active={pointer}
			view={view}
			dev={dev}
			ops={ops}
			files={host.listFiles()}
			running={sessions.find((session) => session.name === pointer)?.badges.includes("running") ?? false}
		/>
	);
}

const isEntryPoint =
	typeof import.meta.main === "boolean" ? import.meta.main : typeof window !== "undefined";

if (isEntryPoint) {
	const host = new Host();
	const ready = host.open("eta-main", () => makeFauxAgent("eta-main"));
	render(<LiveApp host={host} ready={ready} />, {
		title: "eta",
		width: 1280,
		height: 800,
		focus: typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
	});
}
