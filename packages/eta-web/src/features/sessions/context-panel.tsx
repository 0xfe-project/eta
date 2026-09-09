import { useEffect, useState, type ReactNode } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";
import { BtwDialog } from "./btw-dialog.tsx";

export function ContextPanel({ session, view }: { session: string; view: SessionView }) {
	const { t } = useAppI18n();
	const [memory, setMemory] = useState<{ text: string; files: string[] } | null>(null);
	const store = etaStore();
	const [compacting, setCompacting] = useState(false);
	const [promptOpen, setPromptOpen] = useState(false);
	const [personaOpen, setPersonaOpen] = useState(false);
	const [jsonOpen, setJsonOpen] = useState(false);
	const [btwOpen, setBtwOpen] = useState(false);
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
		<div className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm" data-testid="context-panel">
			<Section title={t("panel.usage")} testid="section-usage" right={<span className="text-[10px]">{(Math.round(view.tokensPerSec * 10) / 10).toFixed(1)} tok/s</span>}>
				<p data-testid="usage-row" className="mono text-[11px] text-muted">
					in {view.usage.input.toLocaleString()} / out {view.usage.output.toLocaleString()} / cache {(view.cacheRate * 100).toFixed(0)}% · epoch {view.compactionEpoch}
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
						<div data-testid="usage-segments" className="mt-1 flex h-1 overflow-hidden bg-overlay">
							{parts.map((part) => (
								<div key={part.key} style={{ width: `${(part.value / total) * 100}%`, background: part.color }} />
							))}
						</div>
					);
				})()}
			</Section>

			<Section title={t("panel.inspect")} testid="section-inspect">
				<div className="grid grid-cols-3 gap-1">
					<Button data-testid="prompt-open" size="sm" variant="outline" className="border-border-strong" disabled={view.prompt === undefined} onClick={() => setPromptOpen(true)}>
						{t("panel.viewPrompt")}
					</Button>
					<Button data-testid="persona-open" size="sm" variant="outline" className="border-border-strong" disabled={view.prompt === undefined && view.personas.length === 0} onClick={() => setPersonaOpen(true)}>
						{t("panel.personas")}
					</Button>
					<Button data-testid="json-open" size="sm" variant="outline" className="border-border-strong" onClick={() => setJsonOpen(true)}>
						{t("panel.viewJson")}
					</Button>
				</div>
				{view.prompt !== undefined ? (
					<p data-testid="prompt-row" className="mono mt-1 text-[10px] text-faint">
						{t("panel.stable")} {view.prompt.stableChars} / {t("panel.adaptive")} {view.prompt.adaptiveChars} · {view.prompt.sections.length} blocks
					</p>
				) : null}
			</Section>

			<Section title={t("panel.goal")} testid="section-goal">
				{view.goal == null ? (
					<p data-testid="goal-hint" className="mono text-[10px] text-muted">/goal <span className="text-faint">…</span></p>
				) : (
					<div data-testid="panel-goal-card" data-goal-status={view.goal.status} className={`flex items-center gap-2 border px-2 py-1 ${view.goal.status === "achieved" ? "border-primary" : "border-border"}`}>
						<span className="mono shrink-0 text-[11px]" style={{ color: view.goal.status === "achieved" ? "var(--primary)" : undefined }}>
							{view.goal.status === "achieved" ? "✓" : view.goal.status === "paused" ? "⏸" : "◆"}
						</span>
						<span className={`mono min-w-0 flex-1 truncate text-[11px] text-muted ${view.goal.status === "achieved" ? "line-through" : ""}`}>{view.goal.objective}</span>
						{view.goal.status === "achieved" ? (
							<span className="mono shrink-0 border border-primary px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase" style={{ color: "var(--primary)" }}>{t("goal.achieved")}</span>
						) : (
							<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session, action: view.goal?.status === "active" ? "pause" : "resume" })}>
								{view.goal.status === "active" ? t("panel.pause") : t("panel.resume")}
							</Button>
						)}
						<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session, action: "clear" })}>{t("panel.clear")}</Button>
					</div>
				)}
			</Section>

			<TasksSection session={session} tasks={view.tasks} />

			<Section title={t("panel.loops")} testid="section-loops" right={<span className="text-[10px]">{view.loops.length}</span>}>
				{view.loops.map((loop) => (
					<div key={loop.id} data-testid={`loop-row-${loop.id}`} className="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
						<span className="min-w-0 flex-1 truncate">{loop.id} · {loop.note} · {loop.runCount}×</span>
						<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "loopToggle", session, id: loop.id, paused: !loop.paused })}>
							{loop.paused ? t("panel.resume") : t("panel.pause")}
						</button>
						<button data-testid={`loop-remove-${loop.id}`} className="mono px-1 text-[11px] text-faint hover:text-danger" onClick={() => send({ op: "loopRemove", session, id: loop.id })}>
							×
						</button>
					</div>
				))}
				<div data-testid="loop-create" className="mono mt-1 flex items-center gap-1">
					<LoopForm session={session} />
				</div>
			</Section>

			<Section title={t("panel.memory")} testid="section-memory" right={view.memory === undefined ? undefined : (
				<Button
					size="sm"
					variant="ghost"
					data-testid="memory-open"
					onClick={() => {
						void fetch(`/api/memory?session=${encodeURIComponent(session)}`)
							.then((response) => response.json() as Promise<{ text: string; files: string[] }>)
							.then(setMemory)
							.catch(() => undefined);
					}}
				>
					{t("panel.viewMemory")}
				</Button>
			)}>
				<p data-testid="memory-row" className="mono text-[11px] text-muted">{view.memory === undefined ? "—" : `${view.memory.chars} chars`}</p>
			</Section>

			{view.subagents.length > 0 ? (
				<Section title={t("panel.fleet")} testid="section-fleet">
					{view.subagents.map((sub) => (
						<div key={sub.id} data-testid={`fleet-row-${sub.id}`} className="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
							<span className="min-w-0 flex-1 truncate">agent {sub.id} · {sub.status} · {sub.turns}t</span>
							<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "subagentStop", session, id: sub.id })}>×</button>
						</div>
					))}
				</Section>
			) : null}

			{view.sideThread.length > 0 ? (
				<Section title={t("panel.btw")} testid="section-btw">
					{view.sideThread.map((thread) => (
						<div
							key={thread.id}
							data-testid={`btw-row-${thread.id}`}
							role="button"
							tabIndex={0}
							onClick={() => setBtwOpen(true)}
							onKeyDown={(event) => event.key === "Enter" && setBtwOpen(true)}
							className="mono flex cursor-pointer items-center gap-2 py-0.5 text-[11px] text-muted hover:text-foreground"
						>
							<span className="min-w-0 flex-1 truncate">{thread.id} · {thread.exchanges.length}x · {thread.saveState}</span>
							<button className="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwSave", session, threadId: thread.id }); }}>save</button>
							<button className="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwClear", session, threadId: thread.id }); }}>×</button>
						</div>
					))}
				</Section>
			) : null}

			{view.stateKeys.length > 0 ? (
				<Section title={t("panel.state")} testid="section-state">
					{view.stateKeys.map((key) => (
						<div key={key} data-testid={`kv-row-${key}`} className="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
							<span className="min-w-0 flex-1 truncate">{key}</span>
							<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "stateDelete", session, key })}>×</button>
						</div>
					))}
				</Section>
			) : null}

			<div className="mt-auto flex gap-2 pt-1">
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

			<Dialog open={promptOpen && view.prompt !== undefined} onOpenChange={setPromptOpen}>
				<DialogContent className="max-w-[720px]" data-testid="prompt-overlay">
					<DialogHeader>
						<DialogTitle>{t("panel.prompt")}</DialogTitle>
					</DialogHeader>
					<DialogBody className="p-3">
						{view.prompt?.sections.map((section, index) => (
							<section key={`${section.name}-${index}`} data-testid={`prompt-section-${section.name}`} className="mb-3">
								<h4 className="mono mb-1 text-[10px] text-muted">
									{t(("prompt." + section.name) as "prompt.base")} · {section.stable ? t("prompt.stable") : t("prompt.adaptive")} · {section.text.length}
								</h4>
								<pre className="mono max-h-[240px] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{section.text}</pre>
							</section>
						))}
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={personaOpen} onOpenChange={setPersonaOpen}>
				<DialogContent className="max-w-[640px]" data-testid="persona-overlay">
					<DialogHeader>
						<DialogTitle>{t("panel.personas")}: {view.personas.join(", ")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						{(() => {
							const sections = (view.prompt?.sections ?? []).filter((section) => section.name === "persona" || section.name === "goal" || section.name === "tasks" || section.name === "memory");
							return sections.length === 0 ? <p className="mono text-[11px] text-faint">—</p> : sections.map((section, index) => (
								<section key={`${section.name}-${index}`} data-testid={`persona-section-${section.name}`} className="mb-3">
									<h4 className="mono mb-1 text-[10px] text-muted">{t(("prompt." + section.name) as "prompt.base")}</h4>
									<pre className="mono max-h-[240px] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{section.text}</pre>
								</section>
							));
						})()}
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
				<DialogContent className="max-w-[720px]" data-testid="json-overlay">
					<DialogHeader>
						<DialogTitle>{t("panel.sessionJson")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<pre data-testid="json-body" className="mono bg-code-bg p-2 text-[11px] whitespace-pre-wrap">
							{JSON.stringify(view, null, 2)}
						</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={memory !== null} onOpenChange={(open) => !open && setMemory(null)}>
				<DialogContent className="max-w-[640px]" data-testid="memory-dialog">
					<DialogHeader>
						<DialogTitle className="mono text-[11px] uppercase tracking-[0.12em]">{t("panel.memory")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						{(memory?.files ?? []).length > 0 ? <p className="mono mb-1 text-[10px] text-faint">{memory?.files.join(", ")}</p> : null}
						<pre className="mono max-h-[48vh] overflow-y-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{memory?.text}</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<BtwDialog session={session} view={view} open={btwOpen} onOpenChange={setBtwOpen} />
		</div>
	);
}

function Section({ title, testid, right, children }: { title: string; testid: string; right?: ReactNode; children: ReactNode }) {
	return (
		<section className="border-t-2 border-border pt-2" data-testid={testid}>
			<header className="mono mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-faint">
				<span>{title}</span>
				{right !== undefined ? <span className="ml-auto flex items-center gap-1 normal-case">{right}</span> : null}
			</header>
			{children}
		</section>
	);
}

function LoopForm({ session }: { session: string }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [note, setNote] = useState("");
	const [every, setEvery] = useState("");
	return (
		<>
			<input
				data-testid="loop-note"
				value={note}
				placeholder={t("loop.note")}
				onChange={(event) => setNote(event.target.value)}
				className="mono min-w-0 flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
			/>
			<input
				data-testid="loop-every"
				value={every}
				placeholder={t("loop.every")}
				onChange={(event) => setEvery(event.target.value)}
				className="mono w-14 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
			/>
			<button
				data-testid="loop-add"
				disabled={note.trim().length === 0}
				onClick={() => {
					store.send({ op: "loopCreate", session, id: `ui-${Date.now().toString(36)}`, note: note.trim(), ...(every.trim().length > 0 ? { every: every.trim() } : {}) });
					setNote("");
				}}
				className="border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground disabled:opacity-50"
			>
				{t("loop.add")}
			</button>
		</>
	);
}

const TASK_ORDER = ["pending", "in_progress", "completed", "cancelled"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

function TasksSection({ session, tasks }: { session: string; tasks: { id: string; content: string; status: string; priority?: string; dependsOn?: string[] }[] }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [open, setOpen] = useState(true);
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	const done = tasks.filter((task) => task.status === "completed").length;
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);
	const commitEdit = () => {
		if (editing !== null && editText.trim().length > 0) send({ op: "taskUpdate", session, id: editing, content: editText.trim() });
		setEditing(null);
	};
	return (
		<section data-testid="tasks-section" className="border-t-2 border-border pt-2">
			<button data-testid="tasks-toggle" onClick={() => setOpen((current) => !current)} className="mono flex w-full items-center gap-2 py-1 text-[9px] tracking-[0.18em] uppercase text-faint hover:text-foreground">
				<span className={`thinking-block-chevron ${open ? "open" : ""}`}>▸</span>
				{t("tasks.title")} {done}/{tasks.length}
				<span className="ml-auto h-0.5 w-16 bg-border">
					<span className="block h-full bg-primary" style={{ width: `${tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100)}%` }} />
				</span>
			</button>
			{open ? (
				<div className="flex flex-col gap-1 border-t border-border p-2">
					{tasks.map((task) => (
						<div key={task.id} data-testid={`task-row-${task.id}`} className="task-row flex items-center gap-2" data-status={task.status}>
							<button
								data-testid={`task-status-${task.id}`}
								title={task.status}
								onClick={() => send({ op: "taskSet", session, id: task.id, status: TASK_ORDER[(TASK_ORDER.indexOf(task.status as (typeof TASK_ORDER)[number]) + 1 + TASK_ORDER.length) % TASK_ORDER.length] })}
								className="task-status-chip shrink-0"
							/>
							{editing === task.id ? (
								<input
									autoFocus
									value={editText}
									onChange={(event) => setEditText(event.target.value)}
									onBlur={commitEdit}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitEdit();
										if (event.key === "Escape") setEditing(null);
									}}
									className="mono min-w-0 flex-1 border border-border-strong bg-transparent px-1 py-0.5 text-[11px] text-foreground outline-none"
								/>
							) : (
								<button
									data-testid={`task-content-${task.id}`}
									onClick={() => {
										setEditing(task.id);
										setEditText(task.content);
									}}
									className="mono min-w-0 flex-1 truncate px-1 py-0.5 text-left text-[11px] text-foreground hover:bg-overlay"
								>
									{task.content}
									{task.dependsOn !== undefined && task.dependsOn.length > 0 ? <span className="ml-1 text-[9px] text-faint">⛓{task.dependsOn.length}</span> : null}
								</button>
							)}
							<button
								data-testid={`task-priority-${task.id}`}
								title="priority"
								onClick={() => send({ op: "taskUpdate", session, id: task.id, priority: PRIORITIES[(PRIORITIES.indexOf((task.priority ?? "medium") as (typeof PRIORITIES)[number]) + 1) % PRIORITIES.length] })}
								className="mono shrink-0 border border-border px-1 text-[9px] text-muted hover:text-foreground"
							>
								{(task.priority ?? "medium").slice(0, 1).toUpperCase()}
							</button>
							<button data-testid={`task-remove-${task.id}`} onClick={() => send({ op: "taskRemove", session, id: task.id })} className="mono shrink-0 px-1 text-[11px] text-faint hover:text-danger">
								×
							</button>
						</div>
					))}
					<div className="mono mt-1 flex items-center gap-1">
						<input
							data-testid="task-new"
							value={draft}
							placeholder={t("tasks.add")}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && draft.trim().length > 0) {
									send({ op: "taskCreate", session, content: draft.trim() });
									setDraft("");
								}
							}}
							className="mono min-w-0 flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
						/>
						<button
							data-testid="task-create"
							disabled={draft.trim().length === 0}
							onClick={() => {
								send({ op: "taskCreate", session, content: draft.trim() });
								setDraft("");
							}}
							className="border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground disabled:opacity-50"
						>
							+
						</button>
					</div>
				</div>
			) : null}
		</section>
	);
}
