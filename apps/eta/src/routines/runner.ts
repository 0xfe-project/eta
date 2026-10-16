/**
 * Running a routine (REFACTOR.md §9, P3.3).
 *
 * A run is a short-lived session with a brief and nobody watching. The instructions carry what a
 * fresh session cannot know: the routine's name and schedule, the brief in force, what the last run
 * handed over, and the time it is now. Its tools are the run's own (`list_runs`, `get_run`,
 * `search_runs`, `finish`) — a routine looks at its own history, not at the whole host.
 *
 * Three rules from AXP that shape this:
 *
 * - **A run reports or says nothing.** `finish` decides; a run that ends without calling it is
 *   `sent` with its last message as the report, or `failed` if it said nothing at all.
 * - **A run does not run forever.** Fifteen minutes, then it is a failure that says so — a routine
 *   that hangs would hold the once-at-a-time slot open.
 * - **Feedback revises the brief.** Not immediately, and not in the run's own path: a background
 *   pass reads the feedback with the brief it was about, and writes the next version. If the brief
 *   moved on meanwhile, it starts over from the newer text rather than overwriting it.
 */
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession, SessionManager } from "@eta/server";
import { registerSessionTools } from "@eta/server";
import { Type } from "typebox";
import type { RoutineRecord, RoutineStore } from "./store";

export interface RoutineRunnerOptions {
	routines: RoutineStore;
	sessions: SessionManager;
	/** Where a run's session works. Routines have no workspace of their own yet. */
	cwd?: string | undefined;
	/** How long a run may take before it is stopped. AXP used fifteen minutes. */
	timeoutMs?: number | undefined;
	/** How many times a revision may restart when the brief moved under it. AXP used three. */
	revisionAttempts?: number | undefined;
	warn?: ((message: string) => void) | undefined;
}

const TIMEOUT_MS = 15 * 60 * 1000;
const REVISION_ATTEMPTS = 3;

/** What a run's session is called, and what its usage is counted under. */
export function routineSubject(routineId: string): string {
	return `routine-${routineId}`;
}

/** The last thing an assistant said: what a report falls back to. */
function lastAssistantText(managed: ManagedSession): string {
	let last = "";
	for (const message of managed.session.journaling.transcript()) {
		if (message.role !== "assistant") continue;
		const content = (message as AgentMessage).content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("");
		if (text.trim().length > 0) last = text;
	}
	return last;
}

export class RoutineRunner {
	readonly #routines: RoutineStore;
	readonly #sessions: SessionManager;
	readonly #cwd: string | undefined;
	readonly #timeoutMs: number;
	readonly #revisionAttempts: number;
	readonly #warn: (message: string) => void;

	constructor(options: RoutineRunnerOptions) {
		this.#routines = options.routines;
		this.#sessions = options.sessions;
		this.#cwd = options.cwd;
		this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		this.#revisionAttempts = options.revisionAttempts ?? REVISION_ATTEMPTS;
		this.#warn = options.warn ?? (() => undefined);
	}

	/**
	 * Run a routine now, unless it is already running.
	 *
	 * The caller does not wait for the report: a run takes minutes, and a scheduler that blocked on
	 * one would miss the next.
	 */
	start(routineId: string, options: { manual?: boolean } = {}): string | undefined {
		const routine = this.#routines.get(routineId);
		if (routine === undefined) return undefined;
		// Paused means paused; "run now" is the one way to run it anyway.
		if (!routine.enabled && options.manual !== true) return undefined;
		const run = this.#routines.startRun(routineId);
		if (run === undefined) return undefined;
		void this.#execute(routine, run.id).catch((error: unknown) => {
			this.#warn(
				`[eta] routine ${routineId} run ${run.id} threw: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		return run.id;
	}

	async #execute(routine: RoutineRecord, runId: string): Promise<void> {
		const managed = await this.#sessions.create({
			...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
			title: `${routine.name}（定时）`,
			model: routine.model,
			// The usage of a run is counted under the routine (P1.3), which is what the subject
			// field is for.
			agentId: routineSubject(routine.id),
		});
		let finished = false;
		const finish = (input: { report?: string; handoff?: string }): void => {
			finished = true;
			this.#routines.finishRun(runId, {
				status: input.report === undefined ? "nothing_new" : "sent",
				...(input.report === undefined ? {} : { report: input.report }),
				...(input.handoff === undefined ? {} : { handoff: input.handoff }),
			});
		};
		registerSessionTools(
			managed.session,
			this.#runTools({ routine, runId, finish }),
		);

		const timer = setTimeout(() => {
			void managed.session.runner.abort();
		}, this.#timeoutMs);
		timer.unref?.();
		try {
			managed.session.kernel.inject({
				role: "user",
				timestamp: Date.now(),
				content: [{ type: "text", text: this.#promptFor(routine) }],
			});
			const result = await managed.session.runner.run();
			if (finished) return;
			const text = lastAssistantText(managed);
			if (result.status === "aborted") {
				this.#routines.finishRun(runId, {
					status: "failed",
					error: `运行超过 ${Math.round(this.#timeoutMs / 60_000)} 分钟，已停止。`,
				});
				return;
			}
			if (result.status === "failed") {
				this.#routines.finishRun(runId, {
					status: "failed",
					error: text.length === 0 ? "运行失败。" : text,
				});
				return;
			}
			// No `finish`: the last thing it said is the report, and saying nothing is a run that
			// found nothing new.
			this.#routines.finishRun(runId, {
				status: text.trim().length === 0 ? "nothing_new" : "sent",
				...(text.trim().length === 0 ? {} : { report: text }),
			});
		} catch (error) {
			if (finished) return;
			this.#routines.finishRun(runId, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timer);
			await this.#sessions.close(managed.meta.id).catch(() => undefined);
		}
	}

	/**
	 * What the run is told.
	 *
	 * Everything it cannot look up: who it is, when it runs, what it is for, what the last run
	 * learned, and what time it is. A routine has no conversation to read back, so this is all of
	 * its context.
	 */
	#promptFor(routine: RoutineRecord): string {
		const brief = this.#routines.brief(routine.id)?.text ?? "";
		const handoff = this.#routines.handoff(routine.id);
		const now = new Date();
		const local = new Intl.DateTimeFormat("zh-CN", {
			timeZone: routine.timezone,
			dateStyle: "full",
			timeStyle: "short",
		}).format(now);
		return [
			`你是定时任务「${routine.name}」。现在是 ${local}（时区 ${routine.timezone}），计划是 ${this.#routines.cron(routine)}。`,
			"",
			"## 你的要求",
			"",
			brief,
			...(handoff === undefined
				? []
				: ["", "## 上一次交接", "", `${handoff.text}（写于 ${handoff.writtenAt}）`]),
			"",
			"## 怎么做",
			"",
			"没有用户在线等你回话。做完之后用 `finish` 交报告；如果这次没有值得说的新东西，用 `finish` 说明没有新内容；想给下一次留话，用 `finish` 的 handoff。可以直接结束，但那样你最后说的话就是报告。",
		].join("\n");
	}

	/** The tools a run has: its own history, and the way to end. */
	#runTools(input: {
		routine: RoutineRecord;
		runId: string;
		finish: (input: { report?: string; handoff?: string }) => void;
	}): KernelTool[] {
		const { routine, runId, finish } = input;
		const runs = (): KernelTool => ({
			name: "list_runs",
			description: "List this routine's past runs, newest first.",
			parameters: Type.Object({ limit: Type.Optional(Type.Number({})) }),
			execute: (args: unknown) => {
				const limit =
					typeof (args as { limit?: number }).limit === "number"
						? (args as { limit: number }).limit
						: 10;
				const list = this.#routines.runs(routine.id, limit);
				return {
					content: [
						{
							type: "text" as const,
							text:
								list.length === 0
									? "还没有历史运行。"
									: list
											.map(
												(run) =>
													`${run.startedAt} [${run.status}] ${run.error ?? run.report?.slice(0, 200) ?? ""}`,
											)
											.join("\n"),
						},
					],
				};
			},
		});
		const get = (): KernelTool => ({
			name: "get_run",
			description: "One past run in full: its report, its handoff and its error.",
			parameters: Type.Object({ run: Type.String({}) }),
			execute: (args: unknown) => {
				const wanted = String((args as { run: string }).run);
				const run = this.#routines
					.runs(routine.id, 200)
					.find((candidate) => candidate.id === wanted || candidate.id.startsWith(wanted));
				return run === undefined
					? { content: [{ type: "text" as const, text: `没有这次运行：${wanted}` }], isError: true }
					: {
							content: [
								{
									type: "text" as const,
									text: `[${run.status}] ${run.startedAt}\n\n${run.report ?? ""}\n\n交接：${run.handoff ?? "（无）"}\n错误：${run.error ?? "（无）"}`,
								},
							],
						};
			},
		});
		const search = (): KernelTool => ({
			name: "search_runs",
			description: "Search this routine's past reports for a word.",
			parameters: Type.Object({ query: Type.String({}) }),
			execute: (args: unknown) => {
				const query = String((args as { query: string }).query).toLowerCase();
				const hits = this.#routines
					.runs(routine.id, 200)
					.filter((run) =>
						`${run.report ?? ""}\n${run.handoff ?? ""}`.toLowerCase().includes(query),
					);
				return {
					content: [
						{
							type: "text" as const,
							text:
								hits.length === 0
									? "没有匹配的历史。"
									: hits
											.map((run) => `${run.startedAt}：${run.report?.slice(0, 200) ?? ""}`)
											.join("\n"),
						},
					],
				};
			},
		});
		const end = (): KernelTool => ({
			name: "finish",
			description:
				"End this run. With a report, the user gets it; without one, this run found nothing new. `handoff` is what the next run should know.",
			parameters: Type.Object({
				report: Type.Optional(Type.String({})),
				handoff: Type.Optional(Type.String({})),
			}),
			execute: (args: unknown) => {
				const value = args as { report?: string; handoff?: string };
				finish({
					...(value.report === undefined ? {} : { report: value.report }),
					...(value.handoff === undefined ? {} : { handoff: value.handoff }),
				});
				return {
					content: [{ type: "text" as const, text: "已结束这次运行。" }],
					terminate: true,
				};
			},
		});
		void runId;
		return [runs(), get(), search(), end()];
	}

	/**
	 * Absorb the feedback a routine has: one revision per pass, from the brief it was about.
	 *
	 * A revision is a model call with the brief and the feedback and nothing else — no tools, no
	 * session history — because what it produces is text that replaces the brief.
	 */
	async revise(routineId: string): Promise<boolean> {
		const routine = this.#routines.get(routineId);
		if (routine === undefined) return false;
		const pending = this.#routines.pendingFeedback(routineId);
		const feedback = pending[0];
		if (feedback === undefined) return false;
		for (let attempt = 0; attempt < this.#revisionAttempts; attempt++) {
			const current = this.#routines.brief(routineId);
			if (current === undefined) return false;
			try {
				const text = await this.#ask(
					routine,
					[
						"你在修订一个定时任务的要求。把用户的反馈吸收进去，输出修订后的完整要求，不要解释。",
						"",
						"## 现在的要求",
						"",
						current.text,
						"",
						"## 用户的反馈",
						"",
						feedback.text,
					].join("\n"),
				);
				if (text.trim().length === 0) throw new Error("修订返回了空内容。");
				const revised = this.#routines.revise({
					routineId,
					text,
					feedbackId: feedback.id,
					// The version this revision read: if it moved on, the loop tries again from the newer
					// text rather than overwriting somebody else's change.
					basedOn: current.version,
				});
				if (revised !== undefined) return true;
			} catch (error) {
				this.#warn(
					`[eta] routine ${routineId} could not revise from feedback: ${error instanceof Error ? error.message : String(error)}`,
				);
				break;
			}
		}
		this.#routines.failRevision(feedback.id);
		return false;
	}

	/** One question, one answer: a session of its own, with no tools to call. */
	async #ask(routine: RoutineRecord, prompt: string): Promise<string> {
		const managed = await this.#sessions.create({
			title: `${routine.name}（修订要求）`,
			model: routine.model,
			agentId: routineSubject(routine.id),
		});
		try {
			managed.session.kernel.inject({
				role: "user",
				timestamp: Date.now(),
				content: [{ type: "text", text: prompt }],
			});
			await managed.session.runner.run();
			return lastAssistantText(managed);
		} finally {
			await this.#sessions.close(managed.meta.id).catch(() => undefined);
		}
	}
}
