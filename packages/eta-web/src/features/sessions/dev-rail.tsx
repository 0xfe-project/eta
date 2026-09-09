import { useRef, useState } from "react";
import { useAppI18n } from "../../i18n.ts";
import type { DevFrame } from "../../lib/protocol.ts";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";

// Graphite rule: hue only where meaning demands it (failure/attention).
const CATEGORY_COLORS: Record<string, string> = {
	retry: "var(--danger)",
	fault: "var(--danger)",
	drift: "var(--danger)",
	ask: "var(--warning)",
	"ask-pending": "var(--warning)",
	goal: "var(--success)",
};

export function DevRail({ frames }: { frames: DevFrame[] }) {
	const { t } = useAppI18n();
	const [filter, setFilter] = useState("");
	const [paused, setPaused] = useState(false);
	const [selected, setSelected] = useState<DevFrame | null>(null);
	const frozen = useRef<DevFrame[]>(frames);
	if (!paused) frozen.current = frames;
	const held = paused ? frozen.current : frames;
	const needle = filter.trim().toLowerCase();
	const shown = needle.length === 0 ? held : held.filter((f) => f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle));

	return (
		<div className="flex h-full flex-col p-2" data-testid="dev-rail">
			<div className="mb-2 flex gap-2">
				<button data-testid="dev-pause" onClick={() => setPaused(!paused)} className="border border-border px-2 py-1 text-[10px] text-muted">
					{paused ? "resume" : "pause"}
				</button>
			</div>
			<input
				data-testid="dev-filter"
				value={filter}
				placeholder={t("panel.filter")}
				onChange={(event) => setFilter(event.target.value)}
				className="mb-2 border border-border bg-background px-2 py-1 text-xs outline-none"
			/>
			<div className="mono flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto text-[10px]">
				{shown
					.slice(-200)
					.reverse()
					.map((frame, index) => (
						<button
							key={`${frame.ts}-${index}`}
							data-testid="dev-frame"
							onClick={() => setSelected(frame)}
							className="flex min-w-0 gap-2 px-1 py-0.5 text-left hover:bg-overlay"
						>
							<span className="shrink-0 text-muted">{new Date(frame.ts).toLocaleTimeString()}</span>
							<span className="shrink-0" style={{ color: CATEGORY_COLORS[frame.category] ?? "var(--muted)" }}>{frame.category}</span>
							<span className="shrink-0">{frame.action}</span>
							<span className="min-w-0 overflow-x-auto whitespace-nowrap text-muted">{JSON.stringify(frame.data)}</span>
						</button>
					))}
			</div>
			<Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
				<DialogContent className="max-w-[720px]" data-testid="dev-frame-dialog">
					<DialogHeader>
						<DialogTitle className="mono text-[11px] uppercase tracking-[0.12em]">
							{selected === null ? "" : `${new Date(selected.ts).toLocaleTimeString()} · ${selected.category} · ${selected.action}`}
						</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<pre className="mono max-h-[52vh] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{selected === null ? "" : JSON.stringify(selected.data, null, 2)}</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
		</div>
	);
}
