import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
	const [height, setHeight] = useState(() => {
		const stored = Number(localStorage.getItem("eta.height.terminal"));
		return Number.isFinite(stored) && stored >= 120 ? stored : Math.round(window.innerHeight * 0.4);
	});
	const heightRef = useRef(height);
	heightRef.current = height;
	const startDrag = (event: ReactPointerEvent) => {
		event.preventDefault();
		const startY = event.clientY;
		const startH = heightRef.current;
		const move = (ev: PointerEvent) => setHeight(Math.min(Math.max(startH + (startY - ev.clientY), 120), Math.round(window.innerHeight * 0.85)));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			try {
				localStorage.setItem("eta.height.terminal", String(heightRef.current));
			} catch {
				/* private mode */
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const close = (id: number) => {
		setTabs((current) => {
			const kept = current.filter((tab) => tab.id !== id);
			if (kept.length === 0) onClose();
			return kept;
		});
		setActive((current) => (current === id ? (tabs.find((tab) => tab.id !== id)?.id ?? 0) : current));
	};

	return (
		<div data-testid="terminal-drawer" className="flex shrink-0 flex-col border-t-2 border-border bg-[#0a0a0a]" style={{ height }}>
			<div data-testid="terminal-resize" onPointerDown={startDrag} className="h-[2px] shrink-0 cursor-row-resize bg-overlay hover:bg-border-strong" />
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
				{cwd !== undefined ? <span data-testid="terminal-cwd" className="mono ml-auto max-w-[220px] self-center truncate text-[9px] text-faint" title={cwd}>{cwd}</span> : <span className="ml-auto" />}
				<button data-testid="terminal-hide" onClick={onClose} className="mono px-3 text-[11px] text-muted hover:text-foreground">
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
			scrollback: 5000,
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
		let ws: WebSocket;
		let disposed = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const send = (frame: Record<string, unknown>) => {
			if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
		};
		const onMessage = (event: MessageEvent) => {
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
		const connect = () => {
			ws = new WebSocket(`${scheme}//${window.location.host}/term`);
			ws.binaryType = "arraybuffer";
			ws.onopen = () => send({ op: "start", cols: term.cols, rows: term.rows, ...(cwd === undefined ? {} : { cwd }) });
			ws.onmessage = onMessage;
			ws.onclose = () => {
				if (!disposed) retry = setTimeout(connect, 700);
			};
		};
		connect();
		const input = term.onData((data) => send({ op: "input", data }));
		const resize = () => {
			fit.fit();
			send({ op: "resize", cols: term.cols, rows: term.rows });
		};
		const observer = new ResizeObserver(resize);
		observer.observe(node);

		return () => {
			disposed = true;
			if (retry !== undefined) clearTimeout(retry);
			observer.disconnect();
			input.dispose();
			ws.close();
			term.dispose();
		};
	}, [cwd]);

	return <div ref={host} data-testid="term-host" className="h-full w-full" />;
}
