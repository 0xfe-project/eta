import { useState, type ReactNode } from "react";

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

/**
 * Responsive shell (GUI-PLAN v2 W2.0): desktop is a three-column grid; on
 * narrow screens only the chat column remains and the side regions become
 * slide-over drawers backed by persisted open flags.
 */
export function AppShell({ sidebar, main, panel }: { sidebar: ReactNode; main: ReactNode; panel: ReactNode }) {
	const [leftOpen, setLeftOpen] = useState(() => storedFlag("eta.drawer.sidebar", true));
	const [rightOpen, setRightOpen] = useState(() => storedFlag("eta.drawer.panel", true));

	return (
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
			{leftOpen || rightOpen ? (
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
			) : null}
			<button
				data-testid="toggle-left"
				onClick={() => {
					persistFlag("eta.drawer.sidebar", !leftOpen);
					setLeftOpen(!leftOpen);
				}}
				className="fixed bottom-3 left-3 z-40 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-muted md:hidden"
			>
				☰
			</button>
			<button
				data-testid="toggle-right"
				onClick={() => {
					persistFlag("eta.drawer.panel", !rightOpen);
					setRightOpen(!rightOpen);
				}}
				className="fixed bottom-3 right-3 z-40 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-muted lg:hidden"
			>
				⧉
			</button>
		</div>
	);
}
