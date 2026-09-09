import { useEffect, useState } from "react";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";
import { BtwDialog } from "./btw-dialog.tsx";

export function ContextPanel({ session, view }: { session: string; view: SessionView }) {
	const { t } = useAppI18n();
	const store = etaStore();
	const [compacting, setCompacting] = useState(false);
	const [promptOpen, setPromptOpen] = useState(false);
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
					<Button data-testid="prompt-open" size="sm" onClick={() => setPromptOpen(true)}>
						{t("panel.viewPrompt")}
					</Button>
				</div>
			) : null}
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
			<div data-testid="json-row" className="flex items-center gap-2">
				<p className="mono min-w-0 flex-1 truncate text-[11px] text-muted">
					{t("panel.tokensPerSec")}: {(Math.round((view.tokensPerSec ?? 0) * 10) / 10).toFixed(1)}
				</p>
				<Button data-testid="json-open" size="sm" onClick={() => setJsonOpen(true)}>
					{t("panel.viewJson")}
				</Button>
			</div>
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
			<p data-testid="persona-row" className="mono text-[11px] text-accent">
				{t("panel.personas")}: {view.personas.join(", ")}
			</p>
			{view.loops.map((loop) => (
				<div key={loop.id} data-testid={`loop-row-${loop.id}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>loop {loop.id} · {loop.note} · {loop.runCount}×</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "loopToggle", session, id: loop.id, paused: !loop.paused })}>
						{loop.paused ? t("panel.resume") : t("panel.pause")}
					</button>
				</div>
			))}
			{view.goal == null ? (
				<p data-testid="goal-hint" className="mono text-[10px] text-muted">/goal <span className="text-faint">…</span></p>
			) : null}
			{view.memory !== undefined ? <p data-testid="memory-row" className="mono text-[11px] text-muted">{t("panel.memory")}: {view.memory.chars} chars</p> : null}
			{view.subagents.map((sub) => (
				<div key={sub.id} data-testid={`fleet-row-${sub.id}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>agent {sub.id} · {sub.status} · {sub.turns}t</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "subagentStop", session, id: sub.id })}>×</button>
				</div>
			))}
			{view.sideThread.map((thread) => (
				<div
					key={thread.id}
					data-testid={`btw-row-${thread.id}`}
					role="button"
					tabIndex={0}
					onClick={() => setBtwOpen(true)}
					onKeyDown={(event) => event.key === "Enter" && setBtwOpen(true)}
					className="mono flex cursor-pointer items-center gap-2 text-[11px] text-muted hover:text-foreground"
				>
					<span className="min-w-0 flex-1 truncate">btw {thread.id} · {thread.exchanges.length}x · {thread.saveState}</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwSave", session, threadId: thread.id }); }}>save</button>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwClear", session, threadId: thread.id }); }}>×</button>
				</div>
			))}
			<BtwDialog session={session} view={view} open={btwOpen} onOpenChange={setBtwOpen} />
			{view.stateKeys.map((key) => (
				<div key={key} data-testid={`kv-row-${key}`} className="mono flex items-center gap-2 text-[11px] text-muted">
					<span>{t("panel.state")}: {key}</span>
					<button className="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "stateDelete", session, key })}>×</button>
				</div>
			))}
			<div className="mt-auto flex gap-2">
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
