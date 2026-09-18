import { For, Index, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { sessionTokenTotal, type SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.tsx";
import { setBtwDialogOpen } from "../../lib/btw.ts";
import { apiFetch } from "../../lib/host.ts";

export function ContextPanel(props: { session: string; view: SessionView }) {
	const i18n = useAppI18n();
	const [memory, setMemory] = createSignal<{ text: string; files: string[]; target?: { path: string } } | null>(null);
	const store = etaStore();
	const [compacting, setCompacting] = createSignal(false);
	const [promptOpen, setPromptOpen] = createSignal(false);
	const [toolsOpen, setToolsOpen] = createSignal(false);
	const [jsonOpen, setJsonOpen] = createSignal(false);
	const [personaPicker, setPersonaPicker] = createSignal(false);
	const [contextWindow, setContextWindow] = createSignal<number | null>(null);
	/**
	 * What the host *means* to run: the id in meta.json, else the configured default. The view
	 * carries what it is actually running. They differ when a swap was refused (an id the
	 * registry does not have), and saying so beats a panel that names a model no turn ever used.
	 */
	const [wanted, setWanted] = createSignal<string | undefined>(undefined);
	const [memoryFiles, setMemoryFiles] = createSignal<string[]>([]);
	const [memoryTargetInfo, setMemoryTargetInfo] = createSignal<{ path: string } | undefined>(undefined);
	const [personaOptions, setPersonaOptions] = createSignal<{ id: string; name: string; custom: boolean }[]>([]);
	const [epochAtRequest, setEpochAtRequest] = createSignal<number | null>(null);
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);

	createEffect(
		on(
			() => props.session,
			(session) => {
				void apiFetch(`/api/models?session=${encodeURIComponent(session)}`)
					.then((response) => response.json() as Promise<{ models: { id: string; contextWindow?: number }[]; current: string }>)
					.then((body) => {
						setWanted(body.current);
						setContextWindow(body.models.find((model) => model.id === body.current)?.contextWindow ?? null);
					})
					.catch(() => setContextWindow(null));
				// Which note files this session reads is the first thing a person asks once they
				// moved the session to another folder, so it goes on the panel, not behind a click.
				void apiFetch(`/api/memory?session=${encodeURIComponent(session)}`)
					.then((response) => response.json() as Promise<{ files?: string[]; target?: { path: string } }>)
					.then((body) => {
						setMemoryFiles(Array.isArray(body.files) ? body.files : []);
						setMemoryTargetInfo(body.target);
					})
					.catch(() => setMemoryFiles([]));
			},
		),
	);

	/** Where this project's notes live (or will, once there is one): `<projectRoot>/.eta/MEMORY.md`. */
	const memoryTarget = () => (memory()?.target ?? memoryTargetInfo())?.path ?? "";

	/** Everything the provider counted for this session, from the first turn to now. */
	const totalTokens = () => sessionTokenTotal(props.view.usage);

	createEffect(() => {
		const requested = epochAtRequest();
		if (requested !== null && props.view.compactionEpoch > requested) {
			setCompacting(false);
			setEpochAtRequest(null);
		}
	});

	createEffect(() => {
		if (!compacting()) return;
		const timer = setTimeout(() => {
			setCompacting(false);
			setEpochAtRequest(null);
		}, 15_000);
		onCleanup(() => clearTimeout(timer));
	});

	return (
		<div class="context-panel flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm" data-testid="context-panel">
			{/*
			 * Which model is answering. Every other number in this panel is read against it, and
			 * until now it lived only in the composer's toolbar — so a swap the harness refused
			 * (an id the registry does not have) was invisible from the panel.
			 */}
			<div data-testid="section-model" class="flex flex-col gap-1">
				<div class="flex items-baseline gap-2">
					<span class="mono text-[9px] uppercase tracking-[0.18em] text-faint">{i18n.t("panel.model")}</span>
					<span data-testid="panel-model" class="mono min-w-0 truncate text-right text-[11px] text-foreground" title={props.view.model}>
						{props.view.model}
					</span>
				</div>
				<Show when={wanted() !== undefined && wanted() !== props.view.model}>
					<p data-testid="panel-model-pending" class="mono text-[10px] text-warning">
						{i18n.t("panel.modelPending")}: {wanted()}
					</p>
				</Show>
			</div>

			<Section
				title={i18n.t("panel.usage")}
				testid="section-usage"
				right={
					<span class="flex items-baseline gap-2 text-[10px]">
						{/* The session's own bill: every token the provider counted, not the slice of
						    context on screen — the donut below is that slice, and the two grow apart
						    the moment a compaction or a long run happens. */}
						<span data-testid="usage-total" class="text-[12px] text-foreground">
							{i18n.t("usage.total")} {totalTokens().toLocaleString()}
						</span>
						<span class="text-muted">{(Math.round(props.view.tokensPerSec * 10) / 10).toFixed(1)} tok/s</span>
					</span>
				}
			>
				<UsageDonut view={props.view} contextWindow={contextWindow()} />
				<p data-testid="usage-row" class="mono mt-1 text-[11px] text-muted">
					in {props.view.usage.input.toLocaleString()} / out {props.view.usage.output.toLocaleString()} / cache read {props.view.usage.cacheRead.toLocaleString()} / cache write {props.view.usage.cacheWrite.toLocaleString()} · {(props.view.cacheRate * 100).toFixed(0)}% · epoch {props.view.compactionEpoch}
				</p>
				<Show when={props.view.usage.cost !== undefined && props.view.usage.cost.total > 0}>
					<p data-testid="usage-cost" class="mono text-[10px] text-faint">
						cost ${props.view.usage.cost.total.toFixed(4)}
					</p>
				</Show>
			</Section>

			<Section
				title={i18n.t("panel.persona")}
				testid="section-persona"
				right={
					<button
						data-testid="persona-switch-open"
						class="border border-border-strong px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] hover:bg-overlay-hover hover:text-foreground"
						onClick={() => {
							setPersonaPicker(true);
							void apiFetch(`/api/personas?session=${encodeURIComponent(props.session)}`)
								.then((response) => response.json() as Promise<{ id: string; name: string; custom: boolean }[]>)
								.then(setPersonaOptions)
								.catch(() => undefined);
						}}
					>
						{i18n.t("panel.personaSwitch")}
					</button>
				}
			>
				<div data-testid="panel-personas" class="flex flex-wrap gap-1">
					<Show when={props.view.personas.length === 0}>
						<span class="text-[11px] text-muted">{i18n.t("panel.noPersona")}</span>
					</Show>
					<For each={props.view.personas}>
						{(persona) => (
							<span data-testid={`panel-persona-${persona}`} class="mono bg-overlay px-1.5 py-0.5 text-[10px]">
								{persona}
							</span>
						)}
					</For>
				</div>
			</Section>

			<Section title={i18n.t("panel.inspect")} testid="section-inspect">
				<div class="grid grid-cols-3 gap-1">
					<Button data-testid="prompt-open" size="sm" variant="outline" class="h-8 border border-border-strong px-2 text-[11px] uppercase tracking-[0.12em] hover:bg-overlay-hover hover:text-foreground" disabled={props.view.prompt === undefined} onClick={() => setPromptOpen(true)}>
						{i18n.t("panel.viewPrompt")}
					</Button>
					<Button data-testid="tools-open" size="sm" variant="outline" class="h-8 border border-border-strong px-2 text-[11px] uppercase tracking-[0.12em] hover:bg-overlay-hover hover:text-foreground" onClick={() => setToolsOpen(true)}>
						{i18n.t("panel.tools")}
					</Button>
					<Button data-testid="json-open" size="sm" variant="outline" class="h-8 border border-border-strong px-2 text-[11px] uppercase tracking-[0.12em] hover:bg-overlay-hover hover:text-foreground" onClick={() => setJsonOpen(true)}>
						{i18n.t("panel.viewJson")}
					</Button>
				</div>
				<Show when={props.view.prompt}>
					{(prompt) => (
						<p data-testid="prompt-row" class="mono mt-1 text-[10px] text-faint">
							{i18n.t("panel.stable")} {prompt().stableChars} / {i18n.t("panel.adaptive")} {prompt().adaptiveChars} · {prompt().sections.length} blocks
						</p>
					)}
				</Show>
			</Section>

			<Section title={i18n.t("panel.goal")} testid="section-goal">
				<Show
					when={props.view.goal}
					fallback={<p data-testid="goal-hint" class="mono text-[10px] text-muted">/goal <span class="text-faint">…</span></p>}
				>
					{(goal) => (
						<div data-testid="panel-goal-card" data-goal-status={goal().status} class={`flex items-center gap-2 border px-2 py-1 ${goal().status === "achieved" ? "border-primary" : "border-border"}`}>
							<span class="mono shrink-0 text-[11px]" style={{ color: goal().status === "achieved" ? "var(--primary)" : undefined }}>
								{goal().status === "achieved" ? "✓" : goal().status === "paused" ? "⏸" : "◆"}
							</span>
							<span class={`mono min-w-0 flex-1 truncate text-[11px] text-muted ${goal().status === "achieved" ? "line-through" : ""}`}>{goal().objective}</span>
							<Show
								when={goal().status === "achieved"}
								fallback={
									<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session: props.session, action: props.view.goal?.status === "active" ? "pause" : "resume" })}>
										{goal().status === "active" ? i18n.t("panel.pause") : i18n.t("panel.resume")}
									</Button>
								}
							>
								<span class="mono shrink-0 border border-primary px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase" style={{ color: "var(--primary)" }}>{i18n.t("goal.achieved")}</span>
							</Show>
							<Button size="sm" variant="ghost" onClick={() => send({ op: "goal", session: props.session, action: "clear" })}>{i18n.t("panel.clear")}</Button>
						</div>
					)}
				</Show>
			</Section>

			<TasksSection session={props.session} tasks={props.view.tasks} />

			<Section title={i18n.t("panel.loops")} testid="section-loops" right={<span class="text-[10px]">{props.view.loops.length}</span>}>
				<For each={props.view.loops}>
					{(loop) => (
						<div data-testid={`loop-row-${loop.id}`} class="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
							{/* The trigger belongs on the row: "runs every 5m, fired 3 times" is the whole
							    reason the row exists, and a count without a cadence cannot be read. */}
							<span class="min-w-0 flex-1 truncate">{loop.id} · {loop.note} · {loop.cron ?? loop.every ?? "event"} · {loop.runCount}×</span>
							<button class="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "loopToggle", session: props.session, id: loop.id, paused: !loop.paused })}>
								{loop.paused ? i18n.t("panel.resume") : i18n.t("panel.pause")}
							</button>
							<button data-testid={`loop-remove-${loop.id}`} class="mono px-1 text-[11px] text-faint hover:text-danger" onClick={() => send({ op: "loopRemove", session: props.session, id: loop.id })}>
								×
							</button>
						</div>
					)}
				</For>
				<div data-testid="loop-create" class="mono mt-1 flex items-center gap-1">
					<LoopForm session={props.session} />
				</div>
			</Section>

			<Section title={i18n.t("panel.memory")} testid="section-memory" right={props.view.memory === undefined ? undefined : (
				<Button
					size="sm"
					variant="ghost"
					data-testid="memory-open"
					onClick={() => {
						void apiFetch(`/api/memory?session=${encodeURIComponent(props.session)}`)
							.then((response) => response.json() as Promise<{ text: string; files: string[]; target?: { path: string } }>)
							.then((body) => {
								setMemory(body);
								setMemoryFiles(body.files ?? []);
								setMemoryTargetInfo(body.target);
							})
							.catch(() => undefined);
					}}
				>
					{i18n.t("panel.viewMemory")}
				</Button>
			)}>
				<p data-testid="memory-row" class="mono text-[11px] text-muted">{props.view.memory === undefined ? "—" : `${props.view.memory.chars} chars`}</p>
				{/*
				 * Memory is project-scoped, so the honest thing to show is the file: which project
				 * notes this session reads, and where its first note will land when it has none.
				 */}
				<Show
					when={memoryFiles().length > 0}
					fallback={
						<p data-testid="memory-none" class="mono mt-1 text-[10px] text-faint">
							{i18n.t("panel.memoryNone", { path: memoryTarget() === "" ? "—" : memoryTarget() })}
						</p>
					}
				>
					<div class="mt-1 flex flex-col gap-0.5">
						<span class="mono text-[9px] uppercase tracking-[0.18em] text-faint">{i18n.t("panel.memoryFrom")}</span>
						<For each={memoryFiles()}>
							{(file) => (
								<span data-testid="memory-file" class="mono truncate text-[10px] text-muted" title={file}>
									{file}
								</span>
							)}
						</For>
					</div>
				</Show>
			</Section>

			<Show when={props.view.subagents.length > 0}>
				<Section title={i18n.t("panel.fleet")} testid="section-fleet">
					<For each={props.view.subagents}>
						{(sub) => (
							<div data-testid={`fleet-row-${sub.id}`} class="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
								<span class="min-w-0 flex-1 truncate">agent {sub.id} · {sub.status} · {sub.turns}t</span>
								<button class="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "subagentStop", session: props.session, id: sub.id })}>×</button>
							</div>
						)}
					</For>
				</Section>
			</Show>

			<Show when={props.view.sideThread.length > 0}>
				<Section title={i18n.t("panel.btw")} testid="section-btw">
					<For each={props.view.sideThread}>
						{(thread) => (
							<div
								data-testid={`btw-row-${thread.id}`}
								role="button"
								tabIndex={0}
								onClick={() => setBtwDialogOpen(true)}
								onKeyDown={(event) => event.key === "Enter" && setBtwDialogOpen(true)}
								class="mono flex cursor-pointer items-center gap-2 py-0.5 text-[11px] text-muted hover:text-foreground"
							>
								<span class="min-w-0 flex-1 truncate">
									{thread.id} · {thread.exchanges.length}x · {thread.saveState}
								</span>
								<button class="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwSave", session: props.session, threadId: thread.id }); }}>save</button>
								<button class="border border-border px-2 py-0.5 text-[10px]" onClick={(event) => { event.stopPropagation(); send({ op: "btwClear", session: props.session, threadId: thread.id }); }}>×</button>
							</div>
						)}
					</For>
				</Section>
			</Show>

			<Show when={props.view.stateKeys.length > 0}>
				<Section title={i18n.t("panel.state")} testid="section-state">
					<For each={props.view.stateKeys}>
						{(key) => (
							<div data-testid={`kv-row-${key}`} class="mono flex items-center gap-2 py-0.5 text-[11px] text-muted">
								<span class="min-w-0 flex-1 truncate">{key}</span>
								<button class="border border-border px-2 py-0.5 text-[10px]" onClick={() => send({ op: "stateDelete", session: props.session, key })}>×</button>
							</div>
						)}
					</For>
				</Section>
			</Show>

			<div class="mt-auto flex gap-2 pt-1">
				<button
					data-testid="panel-compact"
					disabled={compacting()}
					class="border border-border px-2 py-1 text-xs text-muted disabled:opacity-50"
					onClick={() => {
						send({ op: "compact", session: props.session });
						setCompacting(true);
						setEpochAtRequest(props.view.compactionEpoch);
					}}
				>
					{compacting() ? i18n.t("panel.compacting") : i18n.t("panel.compact")}
				</button>
				<button data-testid="panel-abort" class="border border-border px-2 py-1 text-xs text-danger" onClick={() => send({ op: "abort", session: props.session })}>{i18n.t("panel.abort")}</button>
			</div>

			<Dialog open={personaPicker()} onOpenChange={setPersonaPicker}>
				<DialogContent data-testid="persona-switch-dialog" class="max-w-sm">
					<DialogHeader>
						<DialogTitle>{i18n.t("panel.personaSwitchTo")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<div class="grid gap-1">
							<For each={personaOptions()}>
								{(option) => (
									<button
										data-testid={`persona-switch-${option.id}`}
										class={`flex items-center gap-2 border border-border px-2 py-1.5 text-left text-sm hover:border-border-strong ${props.view.personas.includes(option.name) ? "border-2 border-primary" : ""}`}
										onClick={() => {
											send({ op: "personaSet", session: props.session, personaId: option.id });
											setPersonaPicker(false);
										}}
									>
										<span class="truncate">{option.name}</span>
										<Show when={option.custom}>
											<span class="ml-auto border border-current px-1 text-[8px] uppercase">{i18n.t("persona.custom")}</span>
										</Show>
									</button>
								)}
							</For>
						</div>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={promptOpen() && props.view.prompt !== undefined} onOpenChange={setPromptOpen}>
				<DialogContent class="max-w-[720px]" data-testid="prompt-overlay">
					<DialogHeader>
						<DialogTitle>{i18n.t("panel.prompt")}</DialogTitle>
					</DialogHeader>
					<DialogBody class="p-3">
						<For each={props.view.prompt?.sections ?? []}>
							{(section) => (
								<section data-testid={`prompt-section-${section.name}`} class="mb-3">
									<h4 class="mono mb-1 text-[10px] text-muted">
										{i18n.t(("prompt." + section.name) as "prompt.base")} · {section.stable ? i18n.t("prompt.stable") : i18n.t("prompt.adaptive")} · {section.text.length}
									</h4>
									<pre class="mono max-h-[240px] overflow-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{section.text}</pre>
								</section>
							)}
						</For>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={toolsOpen()} onOpenChange={setToolsOpen}>
				<DialogContent class="max-w-[640px]" data-testid="tools-overlay">
					<DialogHeader>
						<DialogTitle>{i18n.t("panel.tools")}: {props.view.tools.length}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<ul class="flex flex-col gap-2">
							<For each={props.view.tools}>
								{(tool) => (
									<li data-testid={`inspect-tool-${tool.name}`} class="border border-border p-2">
										<span class="mono text-[11px] uppercase tracking-[0.12em] text-foreground">{tool.name}</span>
										<p class="mono mt-1 text-[10px] leading-relaxed text-muted">{tool.description}</p>
									</li>
								)}
							</For>
						</ul>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={jsonOpen()} onOpenChange={setJsonOpen}>
				<DialogContent class="max-w-[720px]" data-testid="json-overlay">
					<DialogHeader>
						<DialogTitle>{i18n.t("panel.sessionJson")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<pre data-testid="json-body" class="mono bg-code-bg p-2 text-[11px] whitespace-pre-wrap">
							{JSON.stringify(props.view, null, 2)}
						</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>
			<Dialog open={memory() !== null} onOpenChange={(open) => !open && setMemory(null)}>
				<DialogContent class="max-w-[640px]" data-testid="memory-dialog">
					<DialogHeader>
						<DialogTitle class="mono text-[11px] uppercase tracking-[0.12em]">{i18n.t("panel.memory")}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<Show when={(memory()?.files ?? []).length > 0}>
							<p class="mono mb-1 text-[10px] text-faint">{memory()?.files.join(", ")}</p>
						</Show>
						<pre class="mono max-h-[48vh] overflow-y-auto bg-code-bg p-2 text-[11px] whitespace-pre-wrap">{memory()?.text}</pre>
					</DialogBody>
				</DialogContent>
			</Dialog>

		</div>
	);
}

function UsageDonut(props: { view: SessionView; contextWindow: number | null }) {
	const i18n = useAppI18n();
	const share = () => props.view.contextShare ?? { userChars: 0, assistantChars: 0, toolChars: 0, toolDefChars: 0 };
	const est = (chars: number) => Math.round(chars / 4);
	const slices = () => [
		{ label: i18n.t("usage.system"), tokens: est(props.view.prompt?.stableChars ?? 0), color: "var(--chart-purple)" },
		{ label: i18n.t("usage.context"), tokens: est(Math.max(0, (props.view.prompt?.adaptiveChars ?? 0) - (props.view.prompt?.stableChars ?? 0))), color: "var(--accent)" },
		{ label: i18n.t("usage.user"), tokens: est(share().userChars), color: "var(--success)" },
		{ label: i18n.t("usage.assistant"), tokens: est(share().assistantChars), color: "var(--warning)" },
		{ label: i18n.t("usage.tooldefs"), tokens: est(share().toolDefChars), color: "var(--chart-blue)", opacity: 0.45 },
		{ label: i18n.t("usage.tool"), tokens: est(share().toolChars), color: "var(--chart-blue)", opacity: 1 },
	];
	const used = () => slices().reduce((sum, slice) => sum + slice.tokens, 0);
	const ctx = () => props.contextWindow ?? 128_000;
	const cap = () => Math.max(ctx(), used(), 1);
	const r = 42;
	const c = 2 * Math.PI * r;
	const dashNodes = () => {
		let offset = 0;
		return slices().map((slice) => {
			const dash = Math.max(0, (slice.tokens / cap()) * c - 1.5);
			const node = { ...slice, dash, offset };
			offset += (slice.tokens / cap()) * c;
			return node;
		});
	};

	return (
		<div class="flex items-center gap-3">
			<svg viewBox="0 0 120 120" class="h-[124px] w-[124px] shrink-0" data-testid="usage-donut">
				<circle cx="60" cy="60" r={r} fill="none" stroke="var(--overlay)" stroke-width="14" />
				{/*
				 * Index, not For: `slices()` builds fresh object literals on every read and
				 * the numbers under it move with every token, so keying by item identity
				 * would rebuild six circles and six legend rows per token — inside the panel
				 * the user is trying to click. There is always one slice per source and the
				 * order is fixed, so position is the honest key and only the attributes move.
				 */}
				<Index each={dashNodes()}>
					{(slice) => (
						<circle cx="60" cy="60" r={r} fill="none" stroke={slice().color} stroke-opacity={slice().opacity ?? 1} stroke-width="14" stroke-dasharray={`${slice().dash} ${c - slice().dash}`} stroke-dashoffset={-slice().offset} transform="rotate(-90 60 60)">
							<title>{`${slice().label}: ~${slice().tokens.toLocaleString()} tokens`}</title>
						</circle>
					)}
				</Index>
				<text x="60" y="57" text-anchor="middle" dominant-baseline="middle" fill="var(--foreground)" font-size="17" font-weight="700">{used().toLocaleString()}</text>
				<text x="60" y="74" text-anchor="middle" dominant-baseline="middle" fill="var(--muted-foreground)" font-size="9">{`ctx ${Math.round(ctx() / 1000)}k · ${Math.min(999, Math.round((used() / ctx()) * 100))}%`}</text>
			</svg>
			<div class="grid min-w-0 flex-1 grid-cols-1 gap-0.5 text-[10px]">
				<Index each={slices()}>
					{(slice) => (
						<span class="flex items-center gap-1.5 truncate text-muted">
							<span class="h-2 w-2 shrink-0" style={{ background: slice().color, opacity: slice().opacity ?? 1 }} />
							<span class="truncate">{slice().label}</span>
							<span class="mono ml-auto text-foreground">~{slice().tokens.toLocaleString()}</span>
						</span>
					)}
				</Index>
				<span class="flex items-center gap-1.5 text-muted">
					<span class="h-2 w-2 shrink-0 bg-overlay" />
					<span class="truncate">{i18n.t("usage.remaining")}</span>
					<span data-testid="usage-remaining" class="mono ml-auto text-foreground">~{Math.max(0, ctx() - used()).toLocaleString()}</span>
				</span>
			</div>
		</div>
	);
}

function Section(props: { title: string; testid: string; right?: JSX.Element; children: JSX.Element }) {
	return (
		<section class="border-t-2 border-border pt-2" data-testid={props.testid}>
			<header class="mono mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-faint">
				<span>{props.title}</span>
				<Show when={props.right !== undefined}>
					<span class="ml-auto flex items-center gap-1 normal-case">{props.right}</span>
				</Show>
			</header>
			{props.children}
		</section>
	);
}

function LoopForm(props: { session: string }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [note, setNote] = createSignal("");
	const [every, setEvery] = createSignal("");
	return (
		<>
			<input
				data-testid="loop-note"
				value={note()}
				placeholder={i18n.t("loop.note")}
				onInput={(event) => setNote(event.currentTarget.value)}
				class="mono min-w-0 flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
			/>
			<input
				data-testid="loop-every"
				value={every()}
				placeholder={i18n.t("loop.every")}
				title={i18n.t("loop.everyHint")}
				onInput={(event) => setEvery(event.currentTarget.value)}
				class="mono w-14 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
			/>
			<button
				data-testid="loop-add"
				/* No interval, no loop: the server rejects it because a spec with no trigger
				   can never come due. Saying so here beats sending it and showing nothing. */
				disabled={note().trim().length === 0 || every().trim().length === 0}
				onClick={() => {
					store.send({ op: "loopCreate", session: props.session, id: `ui-${Date.now().toString(36)}`, note: note().trim(), every: every().trim() });
					setNote("");
				}}
				class="border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground disabled:opacity-50"
			>
				{i18n.t("loop.add")}
			</button>
		</>
	);
}

const TASK_ORDER = ["pending", "in_progress", "completed", "cancelled"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

function TasksSection(props: { session: string; tasks: { id: string; content: string; status: string; priority?: string; dependsOn?: string[] }[] }) {
	const i18n = useAppI18n();
	const store = etaStore();
	const [open, setOpen] = createSignal(true);
	const [draft, setDraft] = createSignal("");
	const [editing, setEditing] = createSignal<string | null>(null);
	const [editText, setEditText] = createSignal("");
	const done = () => props.tasks.filter((task) => task.status === "completed").length;
	const send = (op: Parameters<typeof store.send>[0]) => store.send(op);
	const commitEdit = () => {
		const id = editing();
		if (id !== null && editText().trim().length > 0) send({ op: "taskUpdate", session: props.session, id, content: editText().trim() });
		setEditing(null);
	};
	return (
		<section data-testid="tasks-section" class="border-t-2 border-border pt-2">
			<button data-testid="tasks-toggle" onClick={() => setOpen((current) => !current)} class="mono flex w-full items-center gap-2 py-1 text-[9px] tracking-[0.18em] uppercase text-faint hover:text-foreground">
				<span class={`thinking-block-chevron ${open() ? "open" : ""}`}>▸</span>
				{i18n.t("tasks.title")} {done()}/{props.tasks.length}
			</button>
			<Show when={open()}>
				<div class="flex flex-col gap-1 border-t border-border p-2">
					<For each={props.tasks}>
						{(task) => (
							<div data-testid={`task-row-${task.id}`} class="task-row flex items-center gap-2" data-status={task.status}>
								<button
									data-testid={`task-status-${task.id}`}
									title={task.status}
									onClick={() => send({ op: "taskSet", session: props.session, id: task.id, status: TASK_ORDER[(TASK_ORDER.indexOf(task.status as (typeof TASK_ORDER)[number]) + 1 + TASK_ORDER.length) % TASK_ORDER.length] })}
									class="task-status-chip shrink-0"
								/>
								<Show
									when={editing() === task.id}
									fallback={
										<button
											data-testid={`task-content-${task.id}`}
											onClick={() => {
												setEditing(task.id);
												setEditText(task.content);
											}}
											class="mono min-w-0 flex-1 truncate px-1 py-0.5 text-left text-[11px] text-foreground hover:bg-overlay"
										>
											{task.content}
											<Show when={task.dependsOn !== undefined && task.dependsOn.length > 0}>
												<span class="ml-1 text-[9px] text-faint">⛓{task.dependsOn?.length}</span>
											</Show>
										</button>
									}
								>
									<input
										autofocus
										value={editText()}
										onInput={(event) => setEditText(event.currentTarget.value)}
										onBlur={commitEdit}
										onKeyDown={(event) => {
											if (event.key === "Enter") commitEdit();
											if (event.key === "Escape") setEditing(null);
										}}
										class="mono min-w-0 flex-1 border border-border-strong bg-transparent px-1 py-0.5 text-[11px] text-foreground outline-none"
									/>
								</Show>
								<button
									data-testid={`task-priority-${task.id}`}
									title="priority"
									onClick={() => send({ op: "taskUpdate", session: props.session, id: task.id, priority: PRIORITIES[(PRIORITIES.indexOf((task.priority ?? "medium") as (typeof PRIORITIES)[number]) + 1) % PRIORITIES.length] })}
									class="mono shrink-0 border border-border px-1 text-[9px] text-muted hover:text-foreground"
								>
									{(task.priority ?? "medium").slice(0, 1).toUpperCase()}
								</button>
								<button data-testid={`task-remove-${task.id}`} onClick={() => send({ op: "taskRemove", session: props.session, id: task.id })} class="mono shrink-0 px-1 text-[11px] text-faint hover:text-danger">
									×
								</button>
							</div>
						)}
					</For>
					<div class="mono mt-1 flex items-center gap-1">
						<input
							data-testid="task-new"
							value={draft()}
							placeholder={i18n.t("tasks.add")}
							onInput={(event) => setDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && draft().trim().length > 0) {
									send({ op: "taskCreate", session: props.session, content: draft().trim() });
									setDraft("");
								}
							}}
							class="mono min-w-0 flex-1 border border-border bg-transparent px-1.5 py-0.5 text-[10px] text-muted outline-none focus:border-border-strong"
						/>
						<button
							data-testid="task-create"
							disabled={draft().trim().length === 0}
							onClick={() => {
								send({ op: "taskCreate", session: props.session, content: draft().trim() });
								setDraft("");
							}}
							class="border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground disabled:opacity-50"
						>
							+
						</button>
					</div>
				</div>
			</Show>
		</section>
	);
}
