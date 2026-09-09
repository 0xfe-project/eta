import { useState } from "react";
import { useLocation } from "wouter";
import { useAppI18n } from "../i18n.ts";
import { etaStore, useEta } from "../lib/eta-store.ts";
import type { InboxTaskJson } from "../lib/protocol.ts";

type Filter = "all" | "pending" | "running" | "done";

const STATUS_DOT: Record<string, string> = {
	pending: "bg-muted",
	needs_input: "bg-warning",
	blocked: "bg-warning",
	running: "bg-accent",
	failed: "bg-danger",
	done: "bg-success",
};

export function InboxPage() {
	const { t } = useAppI18n();
	const state = useEta();
	const store = etaStore();
	const [, navigate] = useLocation();
	const [filter, setFilter] = useState<Filter>("all");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");

	const shown = state.tasks.filter((task) =>
		filter === "all" ? true : filter === "pending" ? task.status === "pending" || task.status === "needs_input" || task.status === "blocked" : filter === "running" ? task.status === "running" || task.status === "failed" : task.status === "done",
	);
	const count = (predicate: (task: InboxTaskJson) => boolean) => state.tasks.filter(predicate).length;

	return (
		<main className="mx-auto flex h-full w-full max-w-[720px] flex-col gap-3 overflow-y-auto p-6" data-testid="inbox-page">
			<div className="flex items-center gap-3">
				<h1 className="text-lg font-semibold">{t("inbox.title")}</h1>
				<button data-testid="inbox-back" onClick={() => navigate("/")} className="ml-auto rounded-lg border border-border px-3 py-1 text-xs text-muted">
					←
				</button>
			</div>
			<p className="text-xs text-muted">{t("inbox.subtitle")}</p>
			<div className="flex gap-2">
				<input data-testid="inbox-title-input" value={title} placeholder={t("inbox.taskTitle")} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none" />
				<input data-testid="inbox-desc-input" value={description} placeholder={t("inbox.taskDesc")} onChange={(e) => setDescription(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none" />
				<button
					data-testid="inbox-add"
					disabled={title.trim().length === 0}
					onClick={() => {
						store.send({ op: "task.create", title: title.trim(), description: description.trim() });
						setTitle("");
						setDescription("");
					}}
					className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40"
					style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
				>
					{t("inbox.add")}
				</button>
			</div>
			<div className="flex gap-1 text-xs" data-testid="inbox-filters">
				{(["all", "pending", "running", "done"] as Filter[]).map((option) => (
					<button key={option} data-testid={`inbox-filter-${option}`} onClick={() => setFilter(option)} className={`rounded-md px-2 py-1 ${filter === option ? "bg-overlay font-medium" : "text-muted"}`}>
						{t(`inbox.filter.${option}` as "inbox.filter.all")} ({count(option === "all" ? () => true : option === "pending" ? (task) => task.status === "pending" || task.status === "needs_input" || task.status === "blocked" : option === "running" ? (task) => task.status === "running" || task.status === "failed" : (task) => task.status === "done")})
					</button>
				))}
				<button data-testid="inbox-clear-done" onClick={() => store.send({ op: "task.clearDone" })} className="ml-auto rounded-md px-2 py-1 text-muted">
					{t("inbox.clearDone")}
				</button>
			</div>
			{shown.length === 0 ? <p className="p-4 text-sm text-muted">{t("inbox.empty")}</p> : null}
			{shown.map((task) => (
				<InboxCard
					key={task.id}
					task={task}
					expanded={expanded === task.id}
					onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
					onApprove={() => store.send({ op: "task.approve", id: task.id })}
					onDismiss={() => store.send({ op: "task.dismiss", id: task.id })}
					onViewSession={() => {
						if (task.dispatch === undefined) return;
						store.send({ op: "focus", session: task.dispatch.childSession });
						navigate("/");
					}}
				/>
			))}
		</main>
	);
}

function InboxCard({ task, expanded, onToggle, onApprove, onDismiss, onViewSession }: { task: InboxTaskJson; expanded: boolean; onToggle(): void; onApprove(): void; onDismiss(): void; onViewSession(): void }) {
	const { t } = useAppI18n();
	return (
		<div data-testid={`inbox-card-${task.id}`} className="rounded-xl border border-border">
			<button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
				<span data-testid={`inbox-status-${task.id}`} className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[task.status] ?? "bg-muted"}`} />
				<span className="truncate">{task.title}</span>
				<span className="ml-auto shrink-0 text-[10px] text-muted">{t(`inbox.status.${task.status}` as "inbox.status.pending")}</span>
				{task.status === "pending" ? (
					<button
						data-testid={`inbox-approve-${task.id}`}
						onClick={(event) => {
							event.stopPropagation();
							onApprove();
						}}
						className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium"
						style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
					>
						{t("inbox.approve")}
					</button>
				) : null}
				<button
					data-testid={`inbox-dismiss-${task.id}`}
					onClick={(event) => {
						event.stopPropagation();
						onDismiss();
					}}
					className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted"
				>
					×
				</button>
			</button>
			{expanded ? (
				<div className="border-t border-border px-3 py-2 text-xs text-muted">
					{task.description.length > 0 ? <p className="whitespace-pre-wrap text-foreground">{task.description}</p> : null}
					<p className="mt-1">source: {task.source.channel} · cwd: {task.targetProject}</p>
					{task.result !== undefined ? <p className="mt-1">result: {task.result.summary}</p> : null}
					{task.dispatch !== undefined ? (
						<button data-testid={`inbox-view-session-${task.id}`} onClick={onViewSession} className="mt-2 rounded-md border border-border px-2 py-0.5 text-[11px]">
							{t("inbox.viewSession")} → {task.dispatch.childSession}
						</button>
					) : null}
					<details className="mt-2" data-testid={`inbox-history-${task.id}`}>
						<summary className="cursor-pointer">{t("inbox.history")} ({task.events.length})</summary>
						<ol className="mono mt-1 flex flex-col gap-0.5 pl-2">
							{task.events.map((event, index) => (
								<li key={index}>
									{new Date(event.at).toLocaleTimeString()} · {event.type} · {event.message}
								</li>
							))}
						</ol>
					</details>
				</div>
			) : null}
		</div>
	);
}
