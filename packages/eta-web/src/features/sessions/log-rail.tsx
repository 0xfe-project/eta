import { For, createEffect, createMemo, createSignal } from "solid-js";
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

export function LogRail(props: { frames: DevFrame[] }) {
	const i18n = useAppI18n();
	const [filter, setFilter] = createSignal("");
	const [paused, setPaused] = createSignal(false);
	const [selected, setSelected] = createSignal<DevFrame | null>(null);
	const frozen: { current: DevFrame[] } = { current: props.frames };
	createEffect(() => {
		if (!paused()) frozen.current = props.frames;
	});
	const held = () => (paused() ? frozen.current : props.frames);
	const shown = createMemo(() => {
		const needle = filter().trim().toLowerCase();
		const list = held();
		return needle.length === 0 ? list : list.filter((frame) => frame.category.toLowerCase().includes(needle) || frame.action.toLowerCase().includes(needle));
	});

	return (
		<div class="flex h-full flex-col p-2" data-testid="log-rail">
			<div class="mb-2 flex gap-2">
				<button data-testid="log-pause" onClick={() => setPaused(!paused())} class="border border-border px-2 py-1 text-[10px] text-muted">
					{paused() ? "resume" : "pause"}
				</button>
			</div>
			<input
				data-testid="log-filter"
				value={filter()}
				placeholder={i18n.t("panel.filter")}
				onInput={(event) => setFilter(event.currentTarget.value)}
				class="mb-2 border border-border bg-background px-2 py-1 text-xs outline-none"
			/>
			<div class="mono flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto text-[10px]">
				<For each={[...shown()].slice(-200).reverse()}>
					{(frame) => (
						<button
							data-testid="log-frame"
							onClick={() => setSelected(frame)}
							class="flex min-w-0 gap-2 px-1 py-0.5 text-left hover:bg-overlay"
						>
							<span class="shrink-0 text-muted">{new Date(frame.ts).toLocaleTimeString()}</span>
							<span class="shrink-0" style={{ color: CATEGORY_COLORS[frame.category] ?? "green" }}>{frame.category}</span>
							<span class="shrink-0">{frame.action}</span>
							<span class="min-w-0 overflow-x-auto whitespace-nowrap text-muted">{JSON.stringify(frame.data)}</span>
						</button>
					)}
				</For>
			</div>
			<Dialog open={selected() !== null} onOpenChange={(open) => !open && setSelected(null)}>
				<DialogContent class="max-w-[720px]" data-testid="log-frame-dialog">
					<DialogHeader>
						<DialogTitle class="mono text-[11px] uppercase tracking-[0.12em]">
							{selected() === null ? "" : `${new Date(selected()!.ts).toLocaleTimeString()} · ${selected()!.category} · ${selected()!.action}`}
						</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<pre class="mono max-h-[52vh] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{selected() === null ? "" : JSON.stringify(selected()!.data, null, 2)}</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
		</div>
	);
}
