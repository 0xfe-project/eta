import { useEffect, useState } from "react";
import { render } from "@gpuix/react";
import { EtaApp, type GuiOps } from "./app.tsx";
import { Host } from "./host.ts";
import type { SidebarSession } from "./fake.ts";
import type { DevFrame, ChannelFrame } from "./channels.ts";
import type { SessionView } from "@eta/core";
import { makeFauxAgent } from "./faux-agent.ts";

export function LiveApp({ host }: { host: Host }) {
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
		void host.prompt(host.attachPointer ?? "eta-main", "hello eta").catch(() => undefined);
		return off;
	}, [host]);

	const ops: GuiOps = {
		focus: (name) => {
			host.focus(name);
			refreshNow();
		},
		prompt: (text) => void host.prompt(pointer, text).catch(() => undefined),
		goal: (action, objective) => host.goal(pointer, action, objective),
		loopToggle: (id, paused) => host.loopToggle(pointer, id, paused),
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
	return <EtaApp sessions={sessions} active={pointer} view={view} dev={dev} ops={ops} />;
}

const isEntryPoint =
	typeof import.meta.main === "boolean" ? import.meta.main : typeof window !== "undefined";

if (isEntryPoint) {
	const host = new Host();
	void host.open("eta-main", () => makeFauxAgent("eta-main"));
	render(<LiveApp host={host} />, {
		title: "eta",
		width: 1280,
		height: 800,
		focus: typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
	});
}
