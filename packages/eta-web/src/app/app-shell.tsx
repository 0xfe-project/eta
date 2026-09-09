import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";

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

/**
 * Responsive shell (GUI-PLAN v2 W2.0): desktop is a three-column layout; on
 * narrow screens only the chat column remains and the side regions become
 * slide-over drawers backed by persisted open flags. Global shortcuts (W2.6)
 * live here so every surface gets them.
 */
export function AppShell({ sidebar, main, panel, palette }: { sidebar: ReactNode; main: ReactNode; panel: ReactNode; palette?: ReactNode }) {
	const [leftOpen, setLeftOpen] = useState(() => storedFlag("eta.drawer.sidebar", true));
	const [rightOpen, setRightOpen] = useState(() => storedFlag("eta.drawer.panel", true));
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [, navigate] = useLocation();

	const toggleLeft = useCallback(() => {
		setLeftOpen((current) => {
			persistFlag("eta.drawer.sidebar", !current);
			return !current;
		});
	}, []);

	const toggleRight = useCallback(() => {
		setRightOpen((current) => {
			persistFlag("eta.drawer.panel", !current);
			return !current;
		});
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const meta = event.metaKey || event.ctrlKey;
			if (!meta) return;
			if (event.key === "b") {
				event.preventDefault();
				toggleLeft();
			}
			if (event.shiftKey && (event.key === "O" || event.key === "o")) {
				event.preventDefault();
				navigate("/new");
			}
			if (event.key === "k") {
				event.preventDefault();
				setPaletteOpen((open) => !open);
			}
			if (event.key === "Escape") setPaletteOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggleLeft, toggleRight, navigate]);

	const value: ShellContextValue = { leftOpen, rightOpen, toggleLeft, toggleRight, paletteOpen, setPaletteOpen };

	return (
		<ShellContext.Provider value={value}>
			<div className="flex h-full overflow-hidden" data-testid="shell">
				<aside
					data-testid="drawer-left"
					data-open={leftOpen ? "1" : "0"}
					className={`w-[260px] shrink-0 border-r border-border bg-surface max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[280px] max-md:shadow-[var(--shadow)] ${leftOpen ? "" : "max-md:hidden"}`}
				>
					{sidebar}
				</aside>
				<main className="flex min-w-0 flex-1 flex-col">{main}</main>
				<aside
					data-testid="drawer-right"
					data-open={rightOpen ? "1" : "0"}
					className={`w-[320px] shrink-0 border-l border-border bg-surface max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[320px] max-lg:shadow-[var(--shadow)] ${rightOpen ? "" : "max-lg:hidden"}`}
				>
					{panel}
				</aside>
				{leftOpen && rightOpen ? null : (
					<button
						aria-label="close drawers"
						data-testid="drawer-scrim"
						onClick={() => {
							setLeftOpen(false);
							persistFlag("eta.drawer.sidebar", false);
							setRightOpen(false);
							persistFlag("eta.drawer.panel", false);
						}}
						className="fixed inset-0 z-20 hidden bg-black/40 max-lg:block"
					/>
				)}
				<button
					data-testid="toggle-left"
					onClick={toggleLeft}
					className="fixed bottom-3 left-3 z-40 border border-border bg-elevated px-3 py-2 text-xs text-muted md:hidden"
				>
					☰
				</button>
				<button
					data-testid="toggle-right"
					onClick={toggleRight}
					className="fixed bottom-3 right-3 z-40 border border-border bg-elevated px-3 py-2 text-xs text-muted lg:hidden"
				>
					⧉
				</button>
				{paletteOpen ? <div data-testid="palette-backdrop" className="fixed inset-0 z-40 bg-black/50" onClick={() => setPaletteOpen(false)} /> : null}
				{paletteOpen ? <div data-testid="palette-slot" className="fixed inset-x-0 top-16 z-50 mx-auto w-[min(92vw,480px)]">{palette}</div> : null}
			</div>
		</ShellContext.Provider>
	);
}
