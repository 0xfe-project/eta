/**
 * The questions of a task's executor: its maker answers first, the user second.
 *
 * An executor that calls `ask_user` puts a row in the Inbox like any session. When the task was
 * made by another agent (a steward in a group, say) and the user is not there to be interrupted,
 * that agent is the first to see the question: it is woken in its lane of the task, as an agent
 * mentioned on it is, and either answers (`answer_task_question`) or sends the question on to the
 * user (`escalate_task_question`). One that does neither is sent on when the deadline passes, so
 * a task never waits on an agent that did not come.
 *
 * All of it is the user's choice (`tasks.autoAnswerAsks`, off by default): off, every question goes
 * to the user as it did before.
 *
 * Whether a question is the maker's is worked out from the row each time, as Captain's
 * `assignmentForInbox` does, so nothing here outlives a restart (which expires every pending
 * question anyway) and the Inbox hides exactly what this says it holds. Left as they were: a task
 * the user made (no maker agent), one its maker executes itself, and Captain's, whose questions are
 * Captain's own relay.
 */
import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { Inbox } from "../inbox/inbox";
import type { TaskBoard } from "./board";
import type { TaskRunner } from "./runner";
import type { TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import { executorOf } from "./store";

/** How long the maker has before the question goes to the user. */
const ASK_OWNER_TIMEOUT_MS = 10 * 60_000;

export interface TaskAsksDeps {
  tasks: Pick<TaskStore, "get">;
  runs: Pick<TaskRunStore, "bySession">;
  agents: Pick<AgentStore, "get">;
  board: Pick<TaskBoard, "comment">;
  runner: Pick<TaskRunner, "consult">;
  inbox: Pick<Inbox, "get">;
  /** Hand an answer to the session that asked: the path every Inbox answer takes. */
  answer: (
    interactionId: string,
    response: InboxResponse,
  ) => Promise<{ answered: boolean }>;
  /** Captain's questions and Captain's tasks are Captain's own. */
  captainOwns: (interaction: InteractionView, makerId: string) => boolean;
  /** Whether the user turned the maker's answering on; read at each question, so a change is at once. */
  enabled: () => boolean;
  /** The Inbox moved. */
  changed: () => void;
  warn: (message: string) => void;
  timeoutMs?: number | undefined;
}

export class TaskAsks {
  readonly #deps: TaskAsksDeps;
  readonly #timeoutMs: number;
  /** The questions sent on to the user. */
  readonly #escalated = new Set<string>();
  /** The questions that were the user's from the start (the setting was off): turning it on later does not take them back. */
  readonly #theirs = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: TaskAsksDeps) {
    this.#deps = deps;
    this.#timeoutMs = deps.timeoutMs ?? ASK_OWNER_TIMEOUT_MS;
  }

  /** The Inbox keeps this question from the user: its maker has it, and has time left. */
  holds(interaction: InteractionView): boolean {
    return (
      interaction.status === "pending" &&
      !this.#theirs.has(interaction.id) &&
      !this.#escalated.has(interaction.id) &&
      Date.now() < interaction.createdAt + this.#timeoutMs &&
      this.#makerOf(interaction) !== undefined
    );
  }

  /** A question became pending: if it is the maker's, wake the maker and start the clock. */
  opened(interaction: InteractionView): void {
    const route = this.#makerOf(interaction);
    if (route === undefined) {
      this.#theirs.add(interaction.id);
      return;
    }
    const timer = setTimeout(
      () => this.#expire(interaction.id),
      Math.max(0, interaction.createdAt + this.#timeoutMs - Date.now()),
    );
    timer.unref?.();
    this.#timers.set(interaction.id, timer);
    this.#deps.runner.consult(
      route.task.id,
      route.makerId,
      this.#brief(route.task, interaction),
    );
  }

  /** The maker answers for the user; the answer and its basis go on the task's timeline. */
  async answer(
    makerId: string,
    input: {
      interactionId: string;
      text?: string | undefined;
      selections?: string[] | undefined;
      basis: string;
    },
  ): Promise<string> {
    const { interaction, task } = this.#held(makerId, input.interactionId);
    const basis = input.basis.trim();
    if (basis === "")
      throw new Error(
        "say in one sentence what the answer rests on: it is written on the task's timeline",
      );
    const name = this.#deps.agents.get(makerId)?.name ?? "The task's maker";
    const said = (input.text ?? "").trim();
    const selections = input.selections ?? [];
    const note = `Answered by ${name}, who made this task, for the user.`;
    if (selections.length === 0 && said === "")
      throw new Error("give an answer: text, or selections from the options");
    const response: InboxResponse =
      selections.length > 0
        ? { kind: "selection", selections, comment: note }
        : { kind: "freeform", text: `${said}\n\n(${note})` };
    const result = await this.#deps.answer(interaction.id, response);
    if (!result.answered) throw new Error("the question is no longer waiting");
    this.#clear(interaction.id);
    this.#deps.board.comment(
      task.id,
      [
        `${name} answered a question of the executor for the user.`,
        `Question: ${interaction.prompt}`,
        `Answer: ${selections.length > 0 ? selections.join(", ") : said}`,
        `Basis: ${basis}`,
      ].join("\n"),
      { kind: "agent", agentId: makerId },
      { deliver: false },
    );
    return "Your answer was delivered to the executor and is on the task's timeline.";
  }

  /** The maker cannot or may not decide: the user sees the question now. */
  escalate(makerId: string, interactionId: string, reason: string): string {
    const { interaction, task } = this.#held(makerId, interactionId);
    this.#send(interaction, task, {
      kind: "agent",
      agentId: makerId,
      why: reason.trim() === "" ? "it needs the user" : reason.trim(),
    });
    return "The question is now in the user's Inbox. Your turn is done.";
  }

  #expire(interactionId: string): void {
    this.#timers.delete(interactionId);
    const interaction = this.#deps.inbox.get(interactionId);
    if (interaction === undefined || interaction.status !== "pending") return;
    const route = this.#makerOf(interaction);
    if (route === undefined || this.#escalated.has(interactionId)) return;
    this.#send(interaction, route.task, {
      kind: "system",
      why: "the maker did not answer in time",
    });
  }

  #send(
    interaction: InteractionView,
    task: TaskRecord,
    by:
      | { kind: "agent"; agentId: string; why: string }
      | { kind: "system"; why: string },
  ): void {
    this.#escalated.add(interaction.id);
    this.#clear(interaction.id);
    this.#deps.changed();
    try {
      this.#deps.board.comment(
        task.id,
        `A question of the executor went to the user's Inbox (${by.why}): ${interaction.prompt}`,
        by.kind === "agent"
          ? { kind: "agent", agentId: by.agentId }
          : { kind: "system", agentId: null },
        { deliver: false },
      );
    } catch (error) {
      this.#deps.warn(
        `[eta] could not record that a question went to the user: ${String(error)}`,
      );
    }
  }

  #clear(interactionId: string): void {
    const timer = this.#timers.get(interactionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(interactionId);
  }

  /** A question this maker may still settle: its own, pending, not yet sent on. */
  #held(
    makerId: string,
    interactionId: string,
  ): { interaction: InteractionView; task: TaskRecord } {
    const interaction = this.#deps.inbox.get(interactionId);
    const route =
      interaction === undefined ? undefined : this.#makerOf(interaction);
    if (
      interaction === undefined ||
      route === undefined ||
      route.makerId !== makerId ||
      !this.holds(interaction)
    )
      throw new Error(
        "that question is not waiting for you: it was answered, it went to the user, or it is not on a task you made",
      );
    return { interaction, task: route.task };
  }

  /** The maker whose question this is, when it is one: asked by a task's executor, made by another agent. */
  #makerOf(
    interaction: InteractionView,
  ): { task: TaskRecord; makerId: string } | undefined {
    if (!this.#deps.enabled()) return undefined;
    const run = this.#deps.runs.bySession(interaction.sessionId);
    // A mentioned agent's own questions go to the user, or two agents could ask each other for ever.
    if (run === undefined || run.agentId !== null) return undefined;
    const task = this.#deps.tasks.get(run.taskId);
    const makerId = task?.createdBy.agentId ?? null;
    if (
      task === undefined ||
      makerId === null ||
      makerId === executorOf(task) ||
      this.#deps.agents.get(makerId) === undefined ||
      this.#deps.captainOwns(interaction, makerId)
    )
      return undefined;
    return { task, makerId };
  }

  #brief(task: TaskRecord, interaction: InteractionView): string {
    const executor = this.#deps.agents.get(executorOf(task) ?? "")?.name;
    const minutes = Math.max(1, Math.round(this.#timeoutMs / 60_000));
    return [
      `This is not a comment from the user. ${executor ?? "The executor"} of task #${task.number}, "${task.title}", asked the user a question, and you made the task, so it comes to you first. The user is often away: answer it if you can.`,
      `## The question (id ${interaction.id})\n\n${interaction.prompt}`,
      interaction.options.length === 0
        ? undefined
        : `Options${interaction.multi ? " (more than one may be chosen)" : ""}:\n${interaction.options.map((option) => `- ${option}`).join("\n")}`,
      `## What to do\n\n- Answer it yourself only if the task description, the project's memory or what was already decided settles it: call answer_task_question with the answer and, in one sentence, its basis. Both are written on the task's timeline, where the user can check them.\n- Send it to the user with escalate_task_question when it involves anything that cannot be undone, spending money, sending something outside, deleting, granting access or authorization, the user's personal preferences, or when you are not sure. When in doubt, send it to the user.\n- Do not use comment_task for this. If you do neither, the question goes to the user in ${minutes} minutes.\n- get_task shows the whole task and its timeline.`,
    ]
      .filter((part) => part !== undefined)
      .join("\n\n");
  }
}
