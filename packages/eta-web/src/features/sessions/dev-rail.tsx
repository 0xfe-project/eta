import { useState } from "react";
import { useAppI18n } from "../../i18n.ts";
import type { DevFrame } from "../../lib/protocol.ts";

const CATEGORY_COLORS: Record<string, string> = {
	goal: "var(--success)",
	todo: "var(--warning)",
	loop: "#8a7fd0",
	ask: "var(--warning)",
	"ask-pending": "var(--warning)",
	btw: "#5aa7c8",
	compaction: "#c8a15a",
	memory: "#63a36a",
	prompt: "#8f8fc8",
	state: "var(--muted)",
	subagent: "#c85a9d",
	usage: "var(--muted)",
	retry: "var(--danger)",
	fault: "var(--danger)",
	drift: "var(--danger)",
	merge: "#5ac8c0",
	queue: "var(--muted)",
	nav: "#9a9a9a",
};

export function DevRail({ frames }: { frames: DevFrame[] }) {
	const { t } = useAppI18n();
	const [filter, setFilter] = useState("");
	const needle = filter.trim().toLowerCase();
	const shown = needle.length === 0 ? frames : frames.filter((f) => f.category.toLowerCase().includes(needle) || f.action.toLowerCase().includes(needle));

	return (
		<div className="flex h-full flex-col p-2" data-testid="dev-rail">
			<input
				data-testid="dev-filter"
				value={filter}
				placeholder={t("panel.filter")}
				onChange={(event) => setFilter(event.target.value)}
				className="mb-2 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none"
			/>
			<div className="mono flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto text-[10px]">
				{shown
					.slice(-200)
					.reverse()
					.map((frame, index) => (
						<div key={`${frame.ts}-${index}`} data-testid="dev-frame" className="flex gap-2 rounded px-1 py-0.5 hover:bg-overlay">
							<span className="text-muted">{new Date(frame.ts).toLocaleTimeString()}</span>
							<span style={{ color: CATEGORY_COLORS[frame.category] ?? "var(--muted)" }}>{frame.category}</span>
							<span>{frame.action}</span>
							<span className="truncate text-muted">{JSON.stringify(frame.data)}</span>
						</div>
					))}
			</div>
		</div>
	);
}
