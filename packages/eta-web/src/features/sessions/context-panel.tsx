import { useEffect, useState } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";

export function ContextPanel({ session, view }: { session: string; view: SessionView }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [goalDraft, setGoalDraft] = useState("");
	const [compacting, setCompacting] = useState(false);
	const [promptOpen, setPromptOpen] = useState(false);
	const [jsonOpen, setJsonOpen] = useState(false);
	const [epochAtRequest, setEpochAtRequest] = useState<number | null>(null);
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);

	useEffect(() => {
		if (epochAtRequest !== null && view.compactionEpoch > epochAtRequest) {
			setCompacting(false);
			setEpochAtRequest(null);
		}
	}, [view.compactionEpoch, epochAtRequest]);

	useEffect(() => {
		if (!compacting) return;
		const timer = setTimeout(() => {
			setCompacting(false);
			setEpochAtRequest(null);
		}, 15_000);
		return () => clearTimeout(timer);
	}, [compacting]);

	return (
		<div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="context-panel">
			<p data-testid="usage-row" className="mono text-[11px] text-muted">
				{t("panel.usage")} in {view.usage.input} / out {view.usage.output} / cache {(view.cacheRate * 100).toFixed(0)}% · epoch {view.compactionEpoch} · {Math.round(view.tokensPerSec)} tok/s
			</p>
			{(() => {
				const usage = view.usage;
				const parts = [
					{ key: "in", value: usage.input, color: "var(--foreground)" },
					{ key: "out", value: usage.output, color: "var(--accent)" },
					{ key: "cr", value: usage.cacheRead, color: "var(--muted)" },
					{ key: "cw", value: usage.cacheWrite, color: "var(--border-strong)" },
				];
				const total = parts.reduce((sum, part) => sum + part.value, 0);
				if (total === 0) return null;
				return (
					<div data-testid="usage-segments" className="flex h-1 overflow-hidden bg-overlay">
						{parts.map((part) => (
							<div key={part.key} style={{ width: `${(part.value / total) * 100}%`, background: part.color }} />
						))}
					</div>
				);
			})()}
			{view.prompt !== undefined ? (
				<div data-testid="prompt-row" className="flex items-center gap-2">
					<p className="mono min-w-0 flex-1 truncate text-[11px] text-muted">
						{t("panel.prompt")}: {t("panel.stable")} {view.prompt.stableChars} / {t("panel.adaptive")} {view.prompt.adaptiveChars}
					</p>
					<button data-testid="prompt-open" onClick={() => setPromptOpen(true)} className="border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-overlay">
						{t("panel.viewPrompt")}
					</button>
				</div>
			) : null}
			{promptOpen && view.prompt !== undefined ? (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="prompt-overlay" onClick={() => setPromptOpen(false)}>
					<div className="dialog max-h-[80vh] w-full max-w-[720px] overflow-hidden" onClick={(event) => event.stopPropagation()}>
						<div className="dialog-header flex items-center gap-2">
							<span className="font-medium">{t("panel.prompt")}</span>
							<button data-testid="prompt-close" onClick={() => setPromptOpen(false)} className="ml-auto border border-border px-2 py-0.5 text-[10px] text-muted">
								{t("common.close")}
							</button>
						</div>
						<div className="dialog-body overflow-y-auto">
							{view.prompt.sections.map((section, index) => (
								<section key={`${section.name}-${index}`} data-testid={`prompt-section-${section.name}`} className="mb-3">
									<h4 className="mono mb-1 text-[10px] text-muted">
										{t(("prompt." + section.name) as "prompt.base")} · {section.stable ? t("prompt.stable") : t("prompt.adaptive")} · {section.text.length}
									</h4>
									<pre className="mono max-h-[240px] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{section.text}</pre>
								</section>
							))}
						</div>
					</div>
				</div>
			) : null}
			<div data-testid="json-row" className="flex items-center gap-2">
				<p className="mono min-w-0 flex-1 truncate text-[11px] text-muted">
					{t("panel.tokensPerSec")}: {(Math.round((view.tokensPerSec ?? 0) * 10) / 10).toFixed(1)}
				</p>
				<button data-testid="json-open" onClick={() => setJsonOpen(true)} className="border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-overlay">
					{t("panel.viewJson")}
				</button>
			</div>
			{jsonOpen ? (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="json-overlay" onClick={() => setJsonOpen(false)}>
					<div className="dialog flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
						<div className="dialog-header flex items-center gap-2">
							<span className="font-medium">{t("panel.sessionJson")}</span>
							<button data-testid="json-close" onClick={() => setJsonOpen(false)} className="ml-auto border border-border px-2 py-0.5 text-[10px] text-muted">
								{t("common.close")}
							</button>
						</div>
						<div className="dialog-body overflow-y-auto">
							<pre data-testid="json-body" className="mono max-h-[70vh] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">
								{JSON.stringify(view, null, 2)}
							</pre>
						</div>
					</div>
				</div>
			) : null}
			<p data-testid="persona-row" className="mono text-[11px] text-accent">
				{t("panel.personas")}: {view.personas.join(", ")}
			</p>
			{view.goal != null ? (
				<div data-testid="goal-card" className="border border-border p-2 text-xs">
					<div className="font-medium">{view.goal.objective}</div>
					<div className="mt-1 flex gap-1">
						{view.goal.status === "active" ? (
							<button className="border border-border px-2 py-0.5 text-[10px] text-muted" onClick={() => send({ op: "goal", session, action: "pause" })}>{t("panel.pause")}</button>
						) : (
							<button className="border border-border px-2 py-0.5 text-[10px] text-muted" onClick={() => send({ op: "goal", session, action: "resume" })}>{t("panel.resume")}</button>
						)}
						<button className="border border-border px-2 py-0.5 text-[10px] text-muted" onClick={() => send({ op: "goal", session, action: "clear" })}>{t("panel.clear")}</button>
					</div>
				</div>
			) : (
				<div className="flex gap-1">
					<input data-testid="goal-input" value={goalDraft} placeholder={t("panel.goal")} onChange={(e) => setGoalDraft(e.target.value)} className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs outline-none" />
					<button
						data-testid="goal-set"
						disabled={goalDraft.trim().length === 0}
						onClick={() => {
							send({ op: "goal", session, action: "set", objective: goalDraft.trim() });
							setGoalDraft("");
						}}
						className="border border-border px-2 py-1 text-xs text-muted disabled:opacity-40"
					>
						{t("panel.goal")}
					</button>
				</div>
			)}
			{view.tasks.length > 0 ? (
				<div data-testid="tasks-list" className="flex flex-col gap-1">
					{view.tasks.map((task) => (
						<button
							key={task.id}
							data-testid={`task-row-${task.id}`}
							onClick={() => send({ op: "taskSet", session, id: task.id, status: task.status === "completed" ? "pending" : "completed" })}
							className="mono text-left text-[11px] text-muted hover:text-accent"
						>
							[{task.status}] {task.content}
						</button>
					))}
				</div>
			) : null}
			{view.loops.map((loop) => (
				<div key={loop.id} data-testid={`loop-row-${loop.id}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>loop {loop.id} · {loop.note} · {loop.runCount}×</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "loopToggle", session, id: loop.id, paused: !loop.paused })}>
						{loop.paused ? t("panel.resume") : t("panel.pause")}
					</button>
				</div>
			))}
			{view.memory !== undefined ? <p data-testid="memory-row" className="mono text-[11px] text-muted">{t("panel.memory")}: {view.memory.chars} chars</p> : null}
			{view.subagents.map((sub) => (
				<div key={sub.id} data-testid={`fleet-row-${sub.id}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>agent {sub.id} · {sub.status} · {sub.turns}t</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "subagentStop", session, id: sub.id })}>×</button>
				</div>
			))}
			{view.sideThread.map((thread) => (
				<div key={thread.id} data-testid={`btw-row-${thread.id}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>btw {thread.id} · {thread.exchanges.length}x · {thread.saveState}</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "btwSave", session, threadId: thread.id })}>save</button>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "btwClear", session, threadId: thread.id })}>×</button>
				</div>
			))}
			{view.stateKeys.map((key) => (
				<div key={key} data-testid={`kv-row-${key}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>{t("panel.state")}: {key}</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "stateDelete", session, key })}>×</button>
				</div>
			))}
			<div className="mt-auto flex gap-2">
				<button data-testid="btw-open" className="border border-border px-2 py-1 text-xs text-muted" onClick={() => send({ op: "btwOpen", session, kind: "tangent" })}>btw</button>
				<button
					data-testid="panel-compact"
					disabled={compacting}
					className="border border-border px-2 py-1 text-xs text-muted disabled:opacity-50"
					onClick={() => {
						send({ op: "compact", session });
						setCompacting(true);
						setEpochAtRequest(view.compactionEpoch);
					}}
				>
					{compacting ? t("panel.compacting") : t("panel.compact")}
				</button>
				<button data-testid="panel-abort" className="border border-border px-2 py-1 text-xs text-danger" onClick={() => send({ op: "abort", session })}>{t("panel.abort")}</button>
			</div>
		</div>
	);
}
