import { Show, createContext, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";

function storedFlag(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : value === "1";
	} catch {
		return fallback;
	}
}

function persistFlag(key: string, open: boolean): void {
	try {
		localStorage.setItem(key, open ? "1" : "0");
	} catch {
		/* private mode */
	}
}

function storedWidth(key: string, fallback: number, min: number, max: number): number {
	try {
		const value = Number(localStorage.getItem(key));
		return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
	} catch {
		return fallback;
	}
}

function Resizer(props: { grow: 1 | -1; storeKey: string; min: number; max: number }) {
	const drag: { current: { x: number; width: number } | null } = { current: null };
	const onPointerDown = (event: PointerEvent) => {
		const current = storedWidth(props.storeKey, props.grow === 1 ? 260 : 320, props.min, props.max);
		drag.current = { x: event.clientX, width: current };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent) => {
		if (drag.current === null) return;
		const next = drag.current.width + props.grow * (event.clientX - drag.current.x);
		const clamped = Math.min(props.max, Math.max(props.min, next));
		localStorage.setItem(props.storeKey, String(clamped));
		window.dispatchEvent(new CustomEvent("eta:width", { detail: { key: props.storeKey, width: clamped } }));
	};
	const onPointerUp = () => {
		drag.current = null;
	};
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			data-testid={`resizer-${props.storeKey}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			class="hidden w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary lg:block"
		/>
	);
}

interface ShellContextValue {
	leftOpen: boolean;
	rightOpen: boolean;
	toggleLeft: () => void;
	toggleRight: () => void;
	paletteOpen: boolean;
	setPaletteOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

export function useShell(): ShellContextValue {
	const value = useContext(ShellContext);
	if (value === undefined) throw new Error("useShell outside AppShell");
	return value;
}

export function useShellOptional(): ShellContextValue | undefined {
	return useContext(ShellContext);
}

function useColumnWidth(key: string, fallback: number, min: number, max: number) {
	const [width, setWidth] = createSignal(storedWidth(key, fallback, min, max));
	const onWidth = (event: Event) => {
		const detail = (event as CustomEvent<{ key: string; width: number }>).detail;
		if (detail.key === key) setWidth(detail.width);
	};
	window.addEventListener("eta:width", onWidth);
	onCleanup(() => window.removeEventListener("eta:width", onWidth));
	return width;
}

export function AppShell(props: { sidebar: JSX.Element; main: JSX.Element; panel: JSX.Element; palette?: JSX.Element }) {
	const leftWidth = useColumnWidth("eta.width.sidebar", 260, 200, 420);
	const rightWidth = useColumnWidth("eta.width.panel", 320, 240, 520);
	const [leftOpen, setLeftOpen] = createSignal(storedFlag("eta.drawer.sidebar", typeof window === "undefined" || window.innerWidth >= 768));
	const [rightOpen, setRightOpen] = createSignal(storedFlag("eta.drawer.panel", typeof window === "undefined" || window.innerWidth >= 1024));
	const [paletteOpen, setPaletteOpen] = createSignal(false);
	const navigate = useNavigate();

	const toggleLeft = () => {
		setLeftOpen((current) => {
			persistFlag("eta.drawer.sidebar", !current);
			return !current;
		});
	};
	const toggleRight = () => {
		setRightOpen((current) => {
			persistFlag("eta.drawer.panel", !current);
			return !current;
		});
	};

	const onKey = (event: KeyboardEvent) => {
		const meta = event.metaKey || event.ctrlKey;
		if (!meta) return;
		if (event.key === "b") {
			event.preventDefault();
			toggleLeft();
		}
		if (event.shiftKey && (event.key === "O" || event.key === "o")) {
			event.preventDefault();
			void navigate("/new");
		}
		if (event.key === "k") {
			event.preventDefault();
			setPaletteOpen((open) => !open);
		}
		if (event.key === "Escape") setPaletteOpen(false);
	};
	window.addEventListener("keydown", onKey);
	onCleanup(() => window.removeEventListener("keydown", onKey));

	const value: ShellContextValue = {
		get leftOpen() {
			return leftOpen();
		},
		get rightOpen() {
			return rightOpen();
		},
		toggleLeft,
		toggleRight,
		get paletteOpen() {
			return paletteOpen();
		},
		setPaletteOpen,
	};

	return (
		<ShellContext.Provider value={value}>
			<div class="flex h-full overflow-hidden" data-testid="shell">
				<aside
					data-testid="drawer-left"
					data-open={leftOpen() ? "1" : "0"}
					style={{ width: `${leftWidth()}px` }}
					class={`shrink-0 border-r border-border bg-surface max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[280px] max-md:shadow-[var(--shadow)] ${leftOpen() ? "" : "max-md:hidden"}`}
				>
					{props.sidebar}
				</aside>
				<Resizer grow={1} storeKey="eta.width.sidebar" min={200} max={420} />
				<main class="flex min-w-0 flex-1 flex-col">{props.main}</main>
				<Resizer grow={-1} storeKey="eta.width.panel" min={240} max={520} />
				<aside
					data-testid="drawer-right"
					data-open={rightOpen() ? "1" : "0"}
					style={{ width: `${rightWidth()}px` }}
					class={`shrink-0 border-l border-border bg-surface max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[320px] max-lg:shadow-[var(--shadow)] ${rightOpen() ? "" : "max-lg:hidden"}`}
				>
					{props.panel}
				</aside>
				<Show when={leftOpen() || rightOpen()}>
					<button
						aria-label="close drawers"
						data-testid="drawer-scrim"
						onClick={() => {
							setLeftOpen(false);
							persistFlag("eta.drawer.sidebar", false);
							setRightOpen(false);
							persistFlag("eta.drawer.panel", false);
						}}
						class={`fixed inset-0 z-20 bg-black/40 ${rightOpen() ? "hidden max-lg:block" : "hidden max-md:block"}`}
					/>
				</Show>
				<button data-testid="toggle-left" onClick={toggleLeft} class="fixed bottom-3 left-3 z-40 border border-border bg-elevated px-3 py-2 text-xs text-muted md:hidden">
					☰
				</button>
				<button data-testid="toggle-right" onClick={toggleRight} class="fixed bottom-3 right-3 z-40 border border-border bg-elevated px-3 py-2 text-xs text-muted lg:hidden">
					⧉
				</button>
				<Show when={paletteOpen()}>
					<div data-testid="palette-backdrop" class="fixed inset-0 z-40 bg-black/50" onClick={() => setPaletteOpen(false)} />
				</Show>
				<Show when={paletteOpen()}>
					<div data-testid="palette-slot" class="fixed inset-x-0 top-16 z-50 mx-auto w-[min(92vw,480px)]">
						{props.palette}
					</div>
				</Show>
			</div>
		</ShellContext.Provider>
	);
}
