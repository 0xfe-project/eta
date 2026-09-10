import { For, Show } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";

/**
 * The strip above the composer: real lane queue, loops, goal (only once set), tasks.
 * Ordering is fixed: queue → loops → goal → tasks.
 */
export function ContextBar(props: { session: string; view: SessionView }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);
	const queue = () => props.view.queue ?? [];
	const empty = () => queue().length === 0 && props.view.loops.length === 0 && props.view.goal == null && props.view.tasks.length === 0;

	return (
		<Show when={!empty()}>
			<div class="flex flex-col gap-1" data-testid="context-bar">
				<Show when={queue().length > 0}>
					<div data-testid="queued-bar" class="queued-messages">
						<For each={queue()}>
							{(item) => (
								<button
									data-testid={`queue-${item.entryId}`}
									title={i18n.t("composer.queueCancel")}
									onClick={() => send({ op: "queueRemove", session: props.session, entryId: item.entryId })}
									class="queued-message-chip"
								>
									{i18n.t("composer.queued")} · {item.text} ×
								</button>
							)}
						</For>
					</div>
				</Show>
				<For each={props.view.loops}>
					{(loop) => (
						<div data-testid={`loop-row-${loop.id}`} class="flex items-center gap-2">
							<span class="mono min-w-0 flex-1 truncate text-[11px] text-muted">
								loop {loop.id} · {loop.note} · {loop.runCount}×
							</span>
							<Button size="sm" variant="ghost" onClick={() => send({ op: "loopToggle", session: props.session, id: loop.id, paused: !loop.paused })}>
								{loop.paused ? i18n.t("panel.resume") : i18n.t("panel.pause")}
							</Button>
						</div>
					)}
				</For>
				<Show when={props.view.goal != null}>
					<div data-testid="goal-card" data-goal-status={props.view.goal?.status} class={`flex items-center gap-2 border px-2 py-1 ${props.view.goal?.status === "achieved" ? "border-primary bg-overlay" : "border-border bg-overlay"}`}>
						<span data-testid="goal-state" class="mono shrink-0 text-[11px]" style={{ color: props.view.goal?.status === "achieved" ? "var(--primary)" : undefined }}>
							{props.view.goal?.status === "achieved" ? "✓" : props.view.goal?.status === "paused" ? "⏸" : "◆"}
						</span>
						<span class={`mono min-w-0 flex-1 truncate text-[11px] text-muted ${props.view.goal?.status === "achieved" ? "line-through" : ""}`}>{props.view.goal?.objective}</span>
						<Show
							when={props.view.goal?.status === "achieved"}
							fallback={
								<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session: props.session, action: props.view.goal?.status === "active" ? "pause" : "resume" })}>
									{props.view.goal?.status === "active" ? i18n.t("panel.pause") : i18n.t("panel.resume")}
								</Button>
							}
						>
							<span data-testid="goal-achieved" class="mono shrink-0 border border-primary px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase" style={{ color: "var(--primary)" }}>
								{i18n.t("goal.achieved")}
							</span>
						</Show>
						<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session: props.session, action: "clear" })}>
							{i18n.t("panel.clear")}
						</Button>
					</div>
				</Show>
				<Show when={props.view.tasks.length > 0}>
					<div data-testid="tasks-list" class="flex flex-wrap gap-x-3 gap-y-1">
						<For each={props.view.tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled")}>
							{(task) => (
								<button
									data-testid={`task-row-${task.id}`}
									onClick={() => send({ op: "taskSet", session: props.session, id: task.id, status: task.status === "completed" ? "pending" : "completed" })}
									class={`mono text-[11px] hover:text-foreground ${task.status === "completed" ? "text-muted line-through" : "text-muted"}`}
								>
									[{task.status === "completed" ? "x" : " "}] {task.content}
								</button>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	);
}
