import { For, Show, createEffect } from "solid-js";
import type { SessionView } from "@eta/core";
import { useAppI18n } from "../../i18n.ts";
import { etaStore } from "../../lib/eta-store.ts";
import { pullBackQueued, steerQueued } from "../../lib/queue-actions.ts";
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
	/** What a message can still move: done and dropped rows are the panel's business. */
	const openTasks = () =>
		props.view.tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
	/**
	 * The plan is longer than the strip is tall, so the strip is a window onto it: three
	 * rows (3 × 18px + the two 2px gaps = 58px), scrolling for the rest, and the window
	 * sits on the newest rows — which is why the plan reads oldest-first and something has
	 * to hold the bottom. It stays there only while the reader is already there: a new row
	 * must not pull the window out of a plan someone scrolled up to read.
	 */
	let rows: HTMLDivElement | undefined;
	let followNewest = true;
	createEffect(() => {
		openTasks().length;
		if (followNewest && rows !== undefined) rows.scrollTop = rows.scrollHeight;
	});
	const atBottom = () =>
		rows !== undefined && rows.scrollHeight - rows.scrollTop - rows.clientHeight < 8;
	/** When the next one is due, as a wall-clock time: an absolute label stays true
	 *  between frames, a countdown written once per frame would quietly go stale. */
	const nextDue = () => {
		const times = props.view.loops
			.filter((loop) => !loop.paused && loop.nextDueAt !== undefined)
			.map((loop) => loop.nextDueAt!);
		if (times.length === 0) return undefined;
		return new Date(Math.min(...times)).toTimeString().slice(0, 5);
	};
	const empty = () => queue().length === 0 && props.view.loops.length === 0 && props.view.goal == null && openTasks().length === 0;

	return (
		<Show when={!empty()}>
			<div class="flex flex-col gap-1" data-testid="context-bar">
				<Show when={queue().length > 0}>
					<div data-testid="queued-bar" class="queued-messages">
						<For each={queue()}>
							{(item) => (
								/* The chip used to be one button that removed the entry. It is now a
								   row: the same text, and what can be done with it. */
								<span data-testid={`queue-${item.entryId}`} class="queued-message-chip" title={item.text}>
									{/* The prefix says which queue the entry is in, because that decides which
									    buttons exist. Without it a ⌘⏎-queued entry (already a steer) looks like a
									    chip with a missing button. */}
									<span class="queued-message-chip-text">
										{item.kind === "steer" ? i18n.t("composer.queuedAsSteer") : i18n.t("composer.queued")} · {item.text}
									</span>
									<span class="queued-message-chip-actions">
									{/* An entry already in the steering queue cannot be steered again — pulling it
									    out and pushing it back as a steer is the same state, so the button would
									    be a lie; only follow-ups get one. */}
									<Show when={item.kind === "followUp"}>
										<button
											data-testid={`queue-steer-${item.entryId}`}
											title={i18n.t("composer.queueSteer")}
											onClick={() => void steerQueued(props.session, item)}
										>
											{i18n.t("composer.queueSteer")}
										</button>
									</Show>
									<button
										data-testid={`queue-return-${item.entryId}`}
										title={i18n.t("composer.queueReturn")}
										onClick={() => void pullBackQueued(props.session, item)}
									>
										{i18n.t("composer.queueReturn")}
									</button>
									<button
										data-testid={`queue-drop-${item.entryId}`}
										title={i18n.t("composer.queueCancel")}
										onClick={() => send({ op: "queueRemove", session: props.session, entryId: item.entryId })}
									>
										×
									</button>
									</span>
								</span>
							)}
						</For>
					</div>
				</Show>
				{/* Loops are not queue traffic: the queue is what runs next, a loop is a
				    cadence, and a row per loop with its own pause button does not belong
				    above the composer. Say that something is scheduled and let the click go
				    to the panel, which is where they are managed. */}
				<Show when={props.view.loops.length > 0}>
					<button
						data-testid="loops-summary"
						onClick={() => window.dispatchEvent(new CustomEvent("eta:show-loops"))}
						class="mono flex items-center gap-2 self-start border border-border px-2 py-0.5 text-[11px] text-muted hover:text-foreground"
					>
						{i18n.t("panel.loops")} {props.view.loops.filter((loop) => !loop.paused).length}/{props.view.loops.length}
						<Show when={nextDue() !== undefined}>
							<span class="text-faint">→ {nextDue()}</span>
						</Show>
					</button>
				</Show>
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
				<Show when={openTasks().length > 0}>
					<div data-testid="tasks-list" class="flex items-start">
						{/* One row per open task, in plan order — nothing is hidden behind a count,
						    because the box scrolls. The scroller is this div, so the ref and the
						    scroll listener are on it and not on the wrapper. */}
						<div
							data-testid="tasks-strip-rows"
							ref={rows}
							onScroll={() => {
								followNewest = atBottom();
							}}
							class="flex max-h-[58px] min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto"
						>
							{/* One click marks a row done and it leaves the strip; anything else about a
							    status (blocked, dropped, dependencies) is the panel's vocabulary. */}
							<For each={openTasks()}>
								{(task) => (
									<button
										data-testid={`task-row-${task.id}`}
										title={task.content}
										onClick={() => send({ op: "taskSet", session: props.session, id: task.id, status: "completed" })}
										class="mono flex h-[18px] w-full shrink-0 items-center gap-1.5 text-left text-[11px] text-muted hover:text-foreground"
									>
										<span class="shrink-0 text-faint">{task.status === "in_progress" ? "[▸]" : "[ ]"}</span>
										<span class="min-w-0 truncate">{task.content}</span>
									</button>
								)}
							</For>
						</div>
					</div>
				</Show>
			</div>
		</Show>
	);
}
