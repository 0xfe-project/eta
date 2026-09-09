import { useState } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { BtwDialog } from "./btw-dialog.tsx";

export function ContextBar({ session, view }: { session: string; view: SessionView }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [goalDraft, setGoalDraft] = useState("");
	const [btwOpen, setBtwOpen] = useState(false);
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);

	return (
		<div className="flex flex-col gap-1" data-testid="context-bar">
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
			) : (
				<form
					className="flex items-center gap-1"
					onSubmit={(event) => {
						event.preventDefault();
						if (goalDraft.trim().length === 0) return;
						send({ op: "goal", session, action: "set", objective: goalDraft.trim() });
						setGoalDraft("");
					}}
				>
					<input
						data-testid="goal-input"
						value={goalDraft}
						placeholder={t("panel.goal")}
						onChange={(event) => setGoalDraft(event.target.value)}
						className="mono min-w-0 flex-1 border border-border bg-transparent px-2 py-0.5 text-[11px] outline-none focus:border-border-strong"
					/>
					<Button data-testid="goal-set" size="sm" type="submit" disabled={goalDraft.trim().length === 0}>
						{t("panel.goal")}
					</Button>
				</form>
			)}
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
			<div className="flex items-center gap-1">
				<Button size="sm" variant="ghost" data-testid="btw-open" onClick={() => { send({ op: "btwOpen", session, kind: "contextual" }); setBtwOpen(true); }}>
					{t("btw.open")}{view.sideThread.length > 0 ? ` · ${view.sideThread.length}` : ""}
				</Button>
				{view.sideThread.length > 0 ? (
					<Button size="sm" variant="ghost" data-testid="btw-show" onClick={() => setBtwOpen(true)}>
						{t("btw.title")}
					</Button>
				) : null}
			</div>
			<BtwDialog session={session} view={view} open={btwOpen} onOpenChange={setBtwOpen} />
		</div>
	);
}
