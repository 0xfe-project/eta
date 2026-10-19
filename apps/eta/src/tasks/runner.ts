import type {
  BoardTaskDetail,
  BoardTaskStatus,
  MessageView,
  TaskActivityView,
  TaskActor,
  TaskQueueReason,
} from "@eta/client-contracts";
import type { SshTransport } from "@eta/ssh";
/**
 * Running tasks: the executor's runs, from the queue to the end.
 *
 * A run is one attempt of the agent that made the task, in a session of its own: opened fresh, so
 * it remembers nothing of the conversation the task came from (the task says what that was), and
 * made the way the agent's conversation sessions are (its model, persona, instructions, tools,
 * skills, MCP servers, bundles and memory), on the machine the task's project is on. The session's
 * transcript is the run's log; there is no second record of what it did.
 *
 * - **A run is a row, and the table is the queue.** A run starts when its machine has a free slot
 *   (`machine.maxActiveRuns` runs at once) and the task's previous run has ended; until then it
 *   says which of the two it waits for. `pump` looks at the queue and is called by everything that
 *   can change the answer (a run asked for, a run ended, a machine came up, the limit moved).
 * - **A run ends with `finish_task`.** The executor calls it to say what it did: the task moves to
 *   review (or `blocked`), its summary is a comment, and the same words are posted in the
 *   conversation the task came from, as the agent. A run that goes quiet without it is reminded
 *   once, then fails.
 * - **A comment on a task reaches the run that is going**: the session gets it as a user message
 *   and carries on. Between two turns it waits in the run and goes in with the next.
 * - **Stopping.** Interrupting a run stops its session; so does moving the task to done or
 *   cancelled. A restart ends the runs it interrupted as failures that say so; queued runs wait.
 * - **The worktree stays.** What a run left in its worktree is the work under review, and the next
 *   run of the task finds it again.
 */
import type { AgentStore } from "../agents/store";
import type { RunHooks, RunInfo } from "../conversations/engine";
import type { SessionHandle } from "../conversations/places";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { TaskBoard, TaskRuns } from "./board";
import type { RunRecord, TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import { LinkError } from "@eta/daemon";
import { shellQuote } from "@eta/ssh";
import { runKey } from "./run-key";
import { prepareWorktree } from "./workspace";

/** What a run says when the process died under it. */
const RUN_RESTART_TEXT = "The server restarted before this run finished.";

export interface TaskRunnerDeps {
  board: TaskBoard;
  tasks: TaskStore;
  runs: TaskRunStore;
  agents: AgentStore;
  machines: MachineStore;
  projects: ProjectStore;
  conversations: ConversationStore;
  timeline: Timeline;
  /** Where sessions are made; the engine knows the places. */
  engine: {
    openRunSession: (input: {
      runId: string;
      title: string;
      agent: NonNullable<ReturnType<AgentStore["get"]>>;
      machine: MachineRecord;
      cwd: string;
      created: (sessionId: string) => void;
    }) => Promise<SessionHandle>;
  };
  /** A way to run a script on a machine: this process's shell, or the daemon over the link. */
  transport: (machine: MachineRecord) => SshTransport;
  dataDir: string;
  /** The features that act around a run (memory, akhook), as they do around a reply. */
  hooks: RunHooks | undefined;
  /** These conversations' timelines moved. */
  changed: (conversations: readonly string[]) => void;
  warn: (message: string) => void;
}

/** What `finish_task` is told. */
export interface Submission {
  summary: string;
  /** Where the task goes: to review (the work is done) or `blocked` (the user must act). */
  status: Extract<BoardTaskStatus, "in_review" | "blocked">;
}

/** A run that is going, as far as this process knows. */
interface Live {
  handle?: SessionHandle | undefined;
  /** Whether a turn of the session is in flight, which a comment can join. */
  inFlight: boolean;
  /** Comments that arrived when no turn was in flight; they go in with the next. */
  pending: string[];
  /** The executor called `finish_task`. */
  reported: boolean;
  /** Why the session was stopped from outside, if it was. */
  stopped: "interrupt" | "closing" | undefined;
  /** What the session last said, for the features that remember. */
  said: string;
}

interface Ended {
  status: "completed" | "failed" | "interrupted";
  error?: string | undefined;
}

const NUDGE =
  "You stopped without calling finish_task. If the task is done, or you cannot go on without " +
  "the user, call finish_task now with a summary of where it stands; otherwise carry on.";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class TaskRunner implements TaskRuns {
  readonly #deps: TaskRunnerDeps;
  readonly #live = new Map<string, Live>();
  readonly #work = new Set<Promise<void>>();
  #attached = false;
  #closing = false;

  constructor(deps: TaskRunnerDeps) {
    this.#deps = deps;
    deps.board.attach(this);
  }

  /** Begin taking runs: the queue is looked at now, and every time something changes. */
  attach(): void {
    this.#attached = true;
    this.#closing = false;
    this.pump();
  }

  /**
   * Stop starting runs and let the ones under way go: their sessions are told to stop, and they
   * end as failures that say the server restarted. Resolves when nothing of this runner is going.
   */
  async detach(): Promise<void> {
    this.#closing = true;
    this.#attached = false;
    for (const live of this.#live.values()) {
      live.stopped = "closing";
      live.handle?.abort();
    }
    await Promise.allSettled([...this.#work]);
  }

  /** Runs the last process left going cannot be going: they end, failed. Before anything starts. */
  recover(): void {
    for (const run of this.#deps.runs.recover(RUN_RESTART_TEXT)) {
      this.#deps.board.runEvent(run.taskId, {
        kind: "run_failed",
        runId: run.id,
        body: RUN_RESTART_TEXT,
      });
    }
  }

  /* ---------------------------------------------------------------- asking for runs */

  /** The task's first run (it was confirmed, or taken out of the backlog). */
  start(taskId: string): void {
    if (!this.#attached) return;
    try {
      this.#queue(taskId);
    } catch (error) {
      // A task that cannot run (no executor, no project) stays a note on the board.
      this.#deps.warn(
        `[eta] task ${taskId} was not queued: ${messageOf(error)}`,
      );
    }
  }

  /** A new run of a task, in a fresh session. Refused while the task has a run that has not ended. */
  rerun(taskId: string): { task: BoardTaskDetail; run: RunRecord } {
    const task = this.#task(taskId);
    if (this.#deps.runs.openOf(task.id).length > 0)
      throw new Error("this task already has a run that has not ended");
    const run = this.#queue(task.id);
    return { task: this.#deps.board.detail(task.id)!, run };
  }

  /** Stop a run: one that waits never starts, one that works is told to stop and ends `interrupted`. */
  interrupt(taskId: string, runId: string): BoardTaskDetail {
    const task = this.#task(taskId);
    const run = this.#deps.runs.get(runId);
    if (run === undefined || run.taskId !== task.id)
      throw new Error(`no such run: ${runId}`);
    if (
      run.status !== "queued" &&
      run.status !== "starting" &&
      run.status !== "running"
    )
      throw new Error("this run has already ended");
    this.#stop(run, "Stopped by the user.");
    return this.#deps.board.detail(task.id)!;
  }

  /** The task is done or cancelled: its runs stop. */
  stop(taskId: string, why: string): void {
    for (const run of this.#deps.runs.openOf(taskId)) this.#stop(run, why);
  }

  active(taskId: string): boolean {
    return this.#deps.runs
      .openOf(taskId)
      .some((run) => run.status === "starting" || run.status === "running");
  }

  /**
   * A comment arrived on the task. The run that is going gets it as a user message and carries on;
   * a task with no run going takes it as a comment and nothing more (a rerun starts afresh).
   */
  deliver(taskId: string, activity: TaskActivityView): void {
    if (activity.body === null || activity.actor.kind === "system") return;
    const run = this.#deps.runs
      .openOf(taskId)
      .find((open) => open.status === "starting" || open.status === "running");
    const live = run === undefined ? undefined : this.#live.get(run.id);
    const task = this.#deps.tasks.get(taskId);
    if (run === undefined || live === undefined || task === undefined) return;
    const who =
      activity.actor.kind === "user"
        ? "the user"
        : (this.#deps.agents.get(activity.actor.agentId ?? "")?.name ??
          "another agent");
    const text = `A comment from ${who} on task #${task.number}:\n\n${activity.body}`;
    const handle = live.handle;
    if (live.inFlight && handle !== undefined) {
      handle.steer(text).catch((error: unknown) => {
        // It could not join the turn (the turn ended under it): it goes in with the next.
        this.#deps.warn(
          `[eta] could not steer run ${run.id}: ${messageOf(error)}`,
        );
        live.pending.push(text);
      });
    } else {
      live.pending.push(text);
    }
  }

  /* ---------------------------------------------------------------- the executor's tools */

  /** The run a session works in, when it works in one. */
  runOf(runId: string): RunRecord | undefined {
    return this.#deps.runs.get(runId);
  }

  /**
   * The executor says it is done (or stuck). The summary becomes a comment, the task moves to
   * review, and the same words are posted in the conversation the task came from, as the agent.
   * Returns what to tell the model, or throws what it should hear as an error.
   */
  submit(runId: string, submission: Submission): string {
    const run = this.#deps.runs.get(runId);
    const live = this.#live.get(runId);
    if (run === undefined || live === undefined || run.status === "queued")
      throw new Error("this run is not going, so there is nothing to finish");
    if (live.reported)
      throw new Error("this run has already finished the task");
    const task = this.#task(run.taskId);
    const executor: TaskActor = {
      kind: "agent",
      agentId: task.createdBy.agentId,
    };
    const summary = submission.summary.trim();
    if (summary === "") throw new Error("finish_task needs a summary");
    // The comment is the executor's own words: the run that wrote it does not read it back.
    this.#deps.board.comment(task.id, summary, executor, { deliver: false });
    this.#deps.board.update(task.id, { status: submission.status }, executor);
    live.reported = true;
    this.#post(task, executor, summary);
    return `Task #${task.number} is now [${submission.status}] and your summary is posted.`;
  }

  /** The result goes where the task came from, in the executor's name. */
  #post(task: TaskRecord, executor: TaskActor, summary: string): void {
    const conversationId = task.originConversationId;
    if (conversationId === null || executor.agentId === null) return;
    try {
      const row: MessageView = this.#deps.timeline.append({
        conversationId,
        kind: "message",
        author: "agent",
        agentId: executor.agentId,
        text: `#${task.number} ${task.title}\n\n${summary}`,
        data: { event: "task_result", taskId: task.id },
      });
      this.#deps.changed([row.conversationId]);
    } catch (error) {
      // A conversation that is gone is not the run's to mourn; the summary is on the task.
      this.#deps.warn(
        `[eta] task ${task.id} could not post its result: ${messageOf(error)}`,
      );
    }
  }

  /* ---------------------------------------------------------------- the queue */

  #task(taskId: string): TaskRecord {
    const task = this.#deps.tasks.find(taskId);
    if (task === undefined) throw new Error(`no such task: ${taskId}`);
    return task;
  }

  /** Queue a run of a task, or say why it cannot have one. */
  #queue(taskId: string): RunRecord {
    const { runs, board, projects, agents } = this.#deps;
    const task = this.#task(taskId);
    if (task.createdBy.kind !== "agent" || task.createdBy.agentId === null)
      throw new Error("this task has no executor: only an agent's task runs");
    if (agents.get(task.createdBy.agentId) === undefined)
      throw new Error("the agent that made this task is gone");
    const project =
      task.projectId === null ? undefined : projects.get(task.projectId);
    if (project === undefined)
      throw new Error("this task's project is gone, so it has nowhere to run");
    const run = runs.create(task.id, project.machineId);
    board.runEvent(task.id, { kind: "run_queued", runId: run.id });
    this.pump();
    return runs.get(run.id)!;
  }

  /** Start the runs that can start. Cheap, and safe to call whenever anything may have changed. */
  pump(): void {
    if (!this.#attached || this.#closing) return;
    const { runs, machines, board } = this.#deps;
    for (const run of runs.queued()) {
      const machine =
        run.machineId === null ? undefined : machines.get(run.machineId);
      let reason: TaskQueueReason | null = null;
      if (machine === undefined || machine.status !== "online")
        reason = "machine_offline";
      else if (runs.busy(run.taskId, run.id)) reason = "task_busy";
      else if (runs.activeOn(machine.id) >= machine.maxActiveRuns)
        reason = "machine_full";
      if (reason !== null || machine === undefined) {
        if (runs.setQueueReason(run.id, reason)) board.runEvent(run.taskId);
        continue;
      }
      if (!runs.start(run.id)) continue;
      board.runEvent(run.taskId);
      const work = this.#execute(runs.get(run.id)!, machine)
        .catch((error: unknown) =>
          this.#deps.warn(
            `[eta] run ${run.id} could not be settled: ${messageOf(error)}`,
          ),
        )
        .finally(() => this.#work.delete(work));
      this.#work.add(work);
    }
  }

  #stop(run: RunRecord, why: string): void {
    const live = this.#live.get(run.id);
    if (live === undefined) {
      // It never started: it never will.
      if (this.#deps.runs.finish(run.id, "interrupted", why) !== undefined) {
        this.#deps.board.runEvent(run.taskId, {
          kind: "run_interrupted",
          runId: run.id,
          body: why,
        });
        this.pump();
      }
      return;
    }
    live.stopped ??= "interrupt";
    if (live.inFlight) live.handle?.abort();
  }

  /* ---------------------------------------------------------------- a run */

  async #execute(run: RunRecord, machine: MachineRecord): Promise<void> {
    const live: Live = {
      inFlight: false,
      pending: [],
      reported: false,
      stopped: undefined,
      said: "",
    };
    this.#live.set(run.id, live);
    let ended: Ended;
    let info: RunInfo | undefined;
    try {
      const made = await this.#drive(run, machine, live);
      ended = made.ended;
      info = made.info;
    } catch (error) {
      // A link cut under the run: what the machine did is unknown, and nothing is run again.
      const lost =
        error instanceof LinkError &&
        (error.kind === "lost" || error.kind === "timeout");
      ended = {
        status: "failed",
        error: lost
          ? `The link to ${machine.name} failed while this run was working, so what it did there is unknown. Nothing was run again. (${error.message})`
          : messageOf(error),
      };
    }
    if (live.stopped === "closing")
      ended = { status: "failed", error: RUN_RESTART_TEXT };
    else if (live.stopped === "interrupt" && ended.status !== "completed")
      ended = { status: "interrupted", error: "Stopped by the user." };
    this.#live.delete(run.id);
    const done = this.#deps.runs.finish(
      run.id,
      ended.status,
      ended.error ?? null,
    );
    if (done !== undefined) {
      this.#deps.board.runEvent(run.taskId, {
        kind: `run_${ended.status}`,
        runId: run.id,
        ...(ended.error === undefined || ended.status === "completed"
          ? {}
          : { body: ended.error }),
      });
    }
    this.#after(info, ended, live.said);
    this.pump();
  }

  /** Everything between "the run may start" and "the session is quiet for good". */
  async #drive(
    run: RunRecord,
    machine: MachineRecord,
    live: Live,
  ): Promise<{ ended: Ended; info?: RunInfo | undefined }> {
    const { board, runs, tasks, agents, projects } = this.#deps;
    const task = tasks.get(run.taskId);
    if (task === undefined)
      return { ended: { status: "failed", error: "The task is gone." } };
    const agent =
      task.createdBy.agentId === null
        ? undefined
        : agents.get(task.createdBy.agentId);
    if (agent === undefined)
      return {
        ended: {
          status: "failed",
          error: "The agent that made this task is gone.",
        },
      };
    const project =
      task.projectId === null ? undefined : projects.get(task.projectId);
    if (project === undefined)
      return {
        ended: { status: "failed", error: "The task's project is gone." },
      };

    // Where it works.
    let cwd = project.path;
    let branch: string | null = null;
    if (task.workspaceMode === "worktree") {
      const made = await prepareWorktree(this.#deps.transport(machine), {
        projectPath: project.path,
        projectId: project.id,
        number: task.number,
        root:
          machine.kind === "primary"
            ? shellQuote(this.#deps.dataDir)
            : '"$HOME/.eta"',
      });
      cwd = made.cwd;
      branch = made.branch;
      if (task.worktreePath !== made.path)
        board.setWorktree(task.id, made.path, made.branch);
    }
    if (live.stopped !== undefined) return { ended: { status: "interrupted" } };

    // A fresh session of the agent: none of what it said in the conversation.
    const handle = await this.#deps.engine.openRunSession({
      runId: run.id,
      title: `#${task.number} ${task.title}`,
      agent,
      machine,
      cwd,
      created: (sessionId) => runs.setSession(run.id, sessionId, cwd),
    });
    live.handle = handle;
    if (live.stopped !== undefined) return { ended: { status: "interrupted" } };

    runs.running(run.id);
    if (task.status !== "in_progress")
      board.update(
        task.id,
        { status: "in_progress" },
        { kind: "system", agentId: null },
      );
    board.runEvent(task.id, {
      kind: "run_started",
      runId: run.id,
      data: { workspace: cwd },
    });

    const told = this.#promptOf(task, cwd, branch);
    const conversationId = task.originConversationId ?? runKey(run.id);
    const info: RunInfo = {
      conversationId,
      agentId: agent.id,
      replyId: run.id,
      sessionId: handle.id,
      cwd: machine.kind === "primary" ? cwd : undefined,
      told,
      trigger: {
        id: run.id,
        conversationId,
        seq: 0,
        kind: "message",
        author: "user",
        agentId: null,
        text: told,
        thinking: "",
        status: "done",
        revision: 1,
        mentions: [],
        rootMessageId: null,
        replyToId: null,
        data: {},
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      },
    };
    const extra = await this.#before(info);
    let prompt = extra === undefined ? told : `${extra}\n\n${told}`;
    // Comments that came while the session was being made.
    if (live.pending.length > 0)
      prompt = `${prompt}\n\n${live.pending.splice(0).join("\n\n")}`;

    for (;;) {
      if (live.stopped !== undefined)
        return { ended: { status: "interrupted" }, info };
      live.inFlight = true;
      let result;
      try {
        result = await handle.run(prompt, () => !this.#closing);
      } finally {
        live.inFlight = false;
      }
      if (result.text.trim() !== "") live.said = result.text;
      if (live.stopped !== undefined || result.status === "aborted")
        return { ended: { status: "interrupted" }, info };
      if (result.status === "failed")
        return {
          ended: { status: "failed", error: result.error ?? "The run failed." },
          info,
        };
      // Comments that came while the turn was ending go in with the next.
      if (live.pending.length > 0) {
        prompt = live.pending.splice(0).join("\n\n");
        continue;
      }
      if (live.reported) return { ended: { status: "completed" }, info };
      const current = runs.get(run.id);
      if (current?.nudged !== true) {
        runs.nudged(run.id);
        board.runEvent(task.id, { kind: "run_nudged", runId: run.id });
        prompt = NUDGE;
        continue;
      }
      return {
        ended: {
          status: "failed",
          error: "The run ended without calling finish_task.",
        },
        info,
      };
    }
  }

  /** What the executor is told first: the task, where it works, and how it reports. */
  #promptOf(task: TaskRecord, cwd: string, branch: string | null): string {
    const conversation =
      task.originConversationId === null
        ? undefined
        : this.#deps.conversations.get(task.originConversationId);
    return [
      `You are the executor of task #${task.number}, "${task.title}". This is a session of its own: you have no memory of the conversation the task came from, and everything you need is here.`,
      `## The task\n\n${task.description.trim() === "" ? "(no description)" : task.description.trim()}`,
      conversation === undefined
        ? undefined
        : `It came from the conversation "${conversation.name}" (id ${conversation.id}); your result is posted there.`,
      `## Where you work\n\n${
        branch === null
          ? `You work in the project's directory, ${cwd}, itself: your changes are made in place.`
          : `You work in ${cwd}, a git worktree of the project on the branch ${branch}. Commit your work there; the worktree stays after you finish, for the user to review.`
      }`,
      `## Reporting\n\n- comment_task posts a progress note or a question on the task.\n- When the work is done, or you cannot go on without the user, call finish_task with a summary: what you did, the result, and what the user should check. It moves the task to review and posts the summary in the conversation. A run that stops without calling it is reminded once, then fails.\n- The user may comment on the task while you work; their comments reach you as messages.\n- Merging (opening a pull request) is decided after review: do not merge into the main branch unless the task says to.\n- get_task shows the whole task with its timeline.`,
    ]
      .filter((part) => part !== undefined)
      .join("\n\n");
  }

  async #before(info: RunInfo): Promise<string | undefined> {
    try {
      const extra = await this.#deps.hooks?.beforeRun?.(info);
      return extra === undefined || extra.trim() === "" ? undefined : extra;
    } catch (error) {
      this.#deps.warn(`[eta] beforeRun failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  /** Tell the features how the run ended, without waiting for them or letting them fail it. */
  #after(info: RunInfo | undefined, ended: Ended, said: string): void {
    const hook = this.#deps.hooks?.afterRun;
    if (info === undefined || hook === undefined) return;
    void Promise.resolve()
      .then(() =>
        hook({
          ...info,
          status:
            ended.status === "completed"
              ? "done"
              : ended.status === "interrupted"
                ? "stopped"
                : "failed",
          said,
        }),
      )
      .catch((error: unknown) =>
        this.#deps.warn(`[eta] afterRun failed: ${messageOf(error)}`),
      );
  }
}
