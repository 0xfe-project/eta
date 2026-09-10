import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useAppI18n } from "../../i18n.ts";
import { withToken, wsUrl } from "../../lib/host.ts";

interface Tab {
	id: number;
}

/**
 * One xterm.js per tab, each backed by a pty on /term. Control frames are JSON;
 * shell output arrives as binary. Two mounts share this component: the bottom
 * drawer (resizable) and the right panel tab (full height, for `vim` and friends).
 */
export function TerminalHost(props: { cwd?: string; variant: "drawer" | "panel"; onClose?: () => void }) {
	const i18n = useAppI18n();
	const drawer = () => props.variant === "drawer";
	const [tabs, setTabs] = createSignal<Tab[]>([{ id: 1 }]);
	const [nextId, setNextId] = createSignal(2);
	const [active, setActive] = createSignal(1);
	const storedHeight = Number(localStorage.getItem("eta.height.terminal"));
	const [height, setHeight] = createSignal(Number.isFinite(storedHeight) && storedHeight >= 120 ? storedHeight : Math.round(window.innerHeight * 0.4));
	const heightBox: { current: number } = { current: height() };
	createEffect(() => {
		heightBox.current = height();
	});
	const startDrag = (event: PointerEvent) => {
		event.preventDefault();
		const startY = event.clientY;
		const startH = heightBox.current;
		const move = (ev: PointerEvent) => setHeight(Math.min(Math.max(startH + (startY - ev.clientY), 120), Math.round(window.innerHeight * 0.85)));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			try {
				localStorage.setItem("eta.height.terminal", String(heightBox.current));
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
			if (kept.length === 0) props.onClose?.();
			return kept;
		});
		setActive((current) => (current === id ? (tabs().find((tab) => tab.id !== id)?.id ?? 0) : current));
	};

	return (
		<div
			data-testid="terminal-host"
			data-variant={props.variant}
			class={`flex flex-col bg-[#0a0a0a] ${drawer() ? "shrink-0 border-t-2 border-border" : "h-full"}`}
			style={drawer() ? { height: `${height()}px` } : undefined}
		>
			<Show when={drawer()}>
				<div data-testid="terminal-resize" onPointerDown={startDrag} class="h-[2px] shrink-0 cursor-row-resize bg-overlay hover:bg-border-strong" />
			</Show>
			<div class="flex items-stretch border-b border-border bg-surface">
				<For each={tabs()}>
					{(tab) => (
						<button
							data-testid={`terminal-tab-${tab.id}`}
							onClick={() => setActive(tab.id)}
							class={`mono flex items-center gap-2 border-r border-border px-3 py-1 text-[11px] ${active() === tab.id ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"}`}
						>
							{i18n.t("term.title")} {tab.id}
							<span
								role="button"
								aria-label="close terminal"
								data-testid={`terminal-close-${tab.id}`}
								onClick={(event) => {
									event.stopPropagation();
									close(tab.id);
								}}
								class="hover:text-foreground"
							>
								×
							</span>
						</button>
					)}
				</For>
				<button
					data-testid="terminal-new"
					onClick={() => {
						const id = nextId();
						setNextId(id + 1);
						setTabs((current) => [...current, { id }]);
						setActive(id);
					}}
					class="mono border-r border-border px-3 text-[11px] text-muted hover:text-foreground"
				>
					{i18n.t("term.new")}
				</button>
				<Show when={props.cwd !== undefined} fallback={<span class="ml-auto" />}>
					<span data-testid="terminal-cwd" class="mono ml-auto max-w-[220px] self-center truncate text-[9px] text-faint" title={props.cwd}>{props.cwd}</span>
				</Show>
				<Show when={drawer()}>
					<button data-testid="terminal-hide" onClick={() => props.onClose?.()} class="mono px-3 text-[11px] text-muted hover:text-foreground">
						✕
					</button>
				</Show>
			</div>
			<div class="relative min-h-0 flex-1">
				<For each={tabs()}>
					{(tab) => (
						<div class={`absolute inset-0 ${active() === tab.id ? "" : "invisible"}`}>
							<TermTab cwd={props.cwd} onExit={() => close(tab.id)} />
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

function TermTab(props: { cwd?: string; onExit: () => void }) {
	let host: HTMLDivElement | undefined;
	const onExitRef: { current: () => void } = { current: props.onExit };
	createEffect(() => {
		onExitRef.current = props.onExit;
	});

	createEffect(
		on(
			() => props.cwd,
			(cwd) => {
				const node = host;
				if (node === undefined) return undefined;
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

				let ws: WebSocket;
				let disposed = false;
				let reconnects = 0;
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
					ws = new WebSocket(withToken(wsUrl("/term")));
					ws.binaryType = "arraybuffer";
					ws.onopen = () => {
						send({ op: "start", cols: term.cols, rows: term.rows, ...(cwd === undefined ? {} : { cwd }) });
						// A restart throws away whatever the user had open in there, so say so.
						if (reconnects++ > 0) term.write("\x1b[2m[terminal reconnected — the shell restarted]\x1b[0m\r\n");
					};
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
				let observer: ResizeObserver | undefined;
				if (typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(resize);
					observer.observe(node);
				} else {
					window.addEventListener("resize", resize);
				}

				onCleanup(() => {
					disposed = true;
					if (retry !== undefined) clearTimeout(retry);
					observer?.disconnect();
					window.removeEventListener("resize", resize);
					input.dispose();
					ws.close();
					term.dispose();
				});
			},
		),
	);

	return (
		<div
			ref={(node) => {
				host = node;
			}}
			data-testid="term-host"
			class="h-full w-full"
		/>
	);
}
