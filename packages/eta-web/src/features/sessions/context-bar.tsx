import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";

/**
 * The strip above the composer: real lane queue, loops, goal (only once set), tasks.
 * Ordering is fixed: queue → loops → goal → tasks.
 */
export function ContextBar({ session, view }: { session: string; view: SessionView }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);

	const queue = view.queue ?? [];
	if (queue.length === 0 && view.loops.length === 0 && view.goal == null && view.tasks.length === 0) return null;

	return (
		<div className="flex flex-col gap-1" data-testid="context-bar">
			{queue.length > 0 ? (
				<div data-testid="queued-bar" className="queued-messages">
					{queue.map((item) => (
						<button
							key={item.entryId}
							data-testid={`queue-${item.entryId}`}
							title={t("composer.queueCancel")}
							onClick={() => send({ op: "queueRemove", session, entryId: item.entryId })}
							className="queued-message-chip"
						>
							{t("composer.queued")} · {item.text} ×
						</button>
					))}
				</div>
			) : null}
			{view.loops.map((loop) => (
				<div key={loop.id} data-testid={`loop-row-${loop.id}`} className="flex items-center gap-2">
					<span className="mono min-w-0 flex-1 truncate text-[11px] text-muted">
						loop {loop.id} · {loop.note} · {loop.runCount}×
					</span>
					<Button size="sm" variant="ghost" onClick={() => send({ op: "loopToggle", session, id: loop.id, paused: !loop.paused })}>
						{loop.paused ? t("panel.resume") : t("panel.pause")}
					</Button>
				</div>
			))}
			{view.goal != null ? (
				<div data-testid="goal-card" className="flex items-center gap-2 border border-border bg-overlay px-2 py-1">
					<span className="mono min-w-0 flex-1 truncate text-[11px] text-muted">◆ {view.goal.objective}</span>
					<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session, action: view.goal?.status === "active" ? "pause" : "resume" })}>
						{view.goal.status === "active" ? t("panel.pause") : t("panel.resume")}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session, action: "clear" })}>
						{t("panel.clear")}
					</Button>
				</div>
			) : null}
			{view.tasks.length > 0 ? (
				<div data-testid="tasks-list" className="flex flex-wrap gap-x-3 gap-y-1">
					{view.tasks.map((task) => (
						<button
							key={task.id}
							data-testid={`task-row-${task.id}`}
							onClick={() => send({ op: "taskSet", session, id: task.id, status: task.status === "completed" ? "pending" : "completed" })}
							className={`mono text-[11px] hover:text-foreground ${task.status === "completed" ? "text-muted line-through" : "text-muted"}`}
						>
							[{task.status === "completed" ? "x" : " "}] {task.content}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
