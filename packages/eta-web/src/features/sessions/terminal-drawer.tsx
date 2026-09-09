import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useAppI18n } from "../../i18n.ts";

interface Tab {
	id: number;
}

/**
 * Bottom terminal drawer: one xterm.js per tab, each backed by a pty on /term.
 * Control frames are JSON; shell output arrives as binary.
 */
export function TerminalDrawer({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
	const { t } = useAppI18n();
	const [tabs, setTabs] = useState<Tab[]>([{ id: 1 }]);
	const [nextId, setNextId] = useState(2);
	const [active, setActive] = useState(1);

	const close = (id: number) => {
		setTabs((current) => {
			const kept = current.filter((tab) => tab.id !== id);
			if (kept.length === 0) onClose();
			return kept;
		});
		setActive((current) => (current === id ? (tabs.find((tab) => tab.id !== id)?.id ?? 0) : current));
	};

	return (
		<div data-testid="terminal-drawer" className="flex h-[40vh] shrink-0 flex-col border-t-2 border-border bg-[#0a0a0a]">
			<div className="flex items-stretch border-b border-border bg-surface">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						data-testid={`terminal-tab-${tab.id}`}
						onClick={() => setActive(tab.id)}
						className={`mono flex items-center gap-2 border-r border-border px-3 py-1 text-[11px] ${active === tab.id ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"}`}
					>
						{t("term.title")} {tab.id}
						<span
							role="button"
							aria-label="close terminal"
							data-testid={`terminal-close-${tab.id}`}
							onClick={(event) => {
								event.stopPropagation();
								close(tab.id);
							}}
							className="hover:text-foreground"
						>
							×
						</span>
					</button>
				))}
				<button
					data-testid="terminal-new"
					onClick={() => {
						const id = nextId;
						setNextId(id + 1);
						setTabs((current) => [...current, { id }]);
						setActive(id);
					}}
					className="mono border-r border-border px-3 text-[11px] text-muted hover:text-foreground"
				>
					{t("term.new")}
				</button>
				<button data-testid="terminal-hide" onClick={onClose} className="mono ml-auto px-3 text-[11px] text-muted hover:text-foreground">
					✕
				</button>
			</div>
			<div className="relative min-h-0 flex-1">
				{tabs.map((tab) => (
					<div key={tab.id} className={`absolute inset-0 ${active === tab.id ? "" : "invisible"}`}>
						<TermTab cwd={cwd} onExit={() => close(tab.id)} />
					</div>
				))}
			</div>
		</div>
	);
}

function TermTab({ cwd, onExit }: { cwd?: string; onExit: () => void }) {
	const host = useRef<HTMLDivElement | null>(null);
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;

	useEffect(() => {
		const node = host.current;
		if (node === null) return undefined;
		const term = new Terminal({
			fontSize: 12,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			cursorBlink: false,
			convertEol: true,
			theme: { background: "#0a0a0a", foreground: "#e8e8e8", cursor: "#e8e8e8" },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new WebLinksAddon());
		term.open(node);
		fit.fit();

		const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${scheme}//${window.location.host}/term`);
		ws.binaryType = "arraybuffer";
		const send = (frame: Record<string, unknown>) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
		};
		ws.onopen = () => send({ op: "start", cols: term.cols, rows: term.rows, ...(cwd === undefined ? {} : { cwd }) });
		ws.onmessage = (event) => {
			if (typeof event.data === "string") {
				try {
					if (JSON.parse(event.data).event === "exit") onExitRef.current();
				} catch {
					/* ignore stray text frames */
				}
				return;
			}
			term.write(new Uint8Array(event.data as ArrayBuffer));
		};
		const input = term.onData((data) => send({ op: "input", data }));
		const resize = () => {
			fit.fit();
			send({ op: "resize", cols: term.cols, rows: term.rows });
		};
		const observer = new ResizeObserver(resize);
		observer.observe(node);

		return () => {
			observer.disconnect();
			input.dispose();
			ws.close();
			term.dispose();
		};
	}, [cwd]);

	return <div ref={host} data-testid="term-host" className="h-full w-full" />;
}
