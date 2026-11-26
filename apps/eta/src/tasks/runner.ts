import type {
  BoardTaskDetail,
  BoardTaskStatus,
  MessageView,
  PromptImage,
  RunFailureView,
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
 * skills, MCP servers and memory), on the machine the agent works on: the one it is pinned
 * to, else the one the task's project is on. A run on another machine than the project's has no
 * project directory or worktree there: it starts in that machine's home and is told so. The
 * session's transcript is the run's log; there is no second record of what it did.
 *
 * - **A run is a row, and the table is the queue.** A run starts when its machine is online with a
 *   free slot (`machine.maxActiveRuns` runs at once) and the task's previous run has ended; until
 *   then it says which it waits for. `pump` looks at the queue and is called by everything that can
 *   change the answer (a run asked for, a run ended, a machine came up, the limit moved, a task's
 *   status or dependencies moved).
 * - **A run that starts the work waits for the task's dependencies** (its first run, a rerun:
 *   `waitsForDeps`). Whether they are resolved is the graph's answer (`graph.ts`), asked through the
 *   board; a comment's wake and a mentioned agent's answer do not wait for them.
 * - **A run ends with `finish_task`.** The executor calls it to say what it did: the task moves to
 *   review (or `blocked`), its summary is a comment, and the same words are posted in the
 *   conversation the task came from, as the agent. A run that goes quiet without it is reminded
 *   once, then fails.
 * - **A comment is always read.** A run that is going gets it as a user message and carries on;
 *   between two turns it waits in the run and goes in with the next. With no run going the comment
 *   is a prompt: it wakes the executor with another run, in the session the task already has, so it
 *   carries on from what it did rather than learning the project again. A task that is not worked
 *   on any more (`backlog`, `done`, `cancelled`) only records the comment.
 * - **Mentions.** A user's comment can mention other agents. Each is woken in a run of its own on
 *   the task (its lane: `agentId` on the run), in a session of its own that it carries on the next
 *   time it is mentioned; it reads the task and the work, answers in the thread and is done — it
 *   does not take the task over or move it. Its answer reaches the executor if a run of it is going,
 *   and wakes nobody. A comment that mentions only others does not wake the executor either.
 * - **Stopping.** Interrupting a run stops its session; so does moving the task to done or
 *   cancelled. A restart ends the runs it interrupted as failures that say so; queued runs wait.
 * - **The worktree stays.** What a run left in its worktree is the work under review, and the next
 *   run of the task finds it again.
 *
 * One session per task is the price of an executor that remembers: its context grows with every
 * comment and every run, and it is `packages/eta-compaction` that keeps that bounded. Starting over
 * with the memory of what was learned is a different thing again, and is not what a comment does:
 * a comment continues, `tasks.rerun` forgets.
 */
import type { AgentStore } from "../agents/store";
import type {
  AttachmentRecord,
  AttachmentStore,
} from "../conversations/attachments";
import type { RunHooks, RunInfo } from "../conversations/engine";
import type { SessionHandle } from "../conversations/places";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { TaskBoard, TaskRuns } from "./board";
import type { RunRecord, TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import type { TaskUsageStore } from "./usage";
import { homedir } from "node:os";
import { isExternalRuntime } from "@eta/client-contracts";
import { LinkError } from "@eta/daemon";
import { shellQuote } from "@eta/ssh";
import { externalAgentProjectError } from "../agents/bounds";
import { explainRunError } from "../agents/model";
import { mentionKey, sessionKeyOf, taskKey } from "../session-owner";
import { workable } from "./status";
import { executorOf } from "./store";
import { prepareWorktree, removeWorktree } from "./workspace";

/**
 * What a run says when the agent that is to execute the task is not in the registry. It names the
 * role the missing id holds and the id itself: the executor is the assignee, and the maker only
 * when nobody else was assigned, so a missing assignee must not read as a missing maker.
 */
function executorGoneText(task: {
  assigneeAgentId: string | null;
  createdBy: { agentId: string | null };
}): string {
  const assignee = task.assigneeAgentId;
  const maker = task.createdBy.agentId;
  if (assignee !== null && assignee !== maker)
    return `the agent assigned to execute this task (${assignee}) is not registered (this is the assignee, not the agent that made the task)`;
  return `the agent that made this task and was to execute it (${maker ?? assignee}) is not registered`;
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

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
      /** What the session is held in (`session-owner.ts`). */
      key: string;
      /** The session to carry on in; null opens a new one. */
      existing: string | null;
      title: string;
      agent: NonNullable<ReturnType<AgentStore["get"]>>;
      machine: MachineRecord;
      cwd: string;
      created: (sessionId: string) => void;
      /** The machine the task's project is on, when the session is made on another one. */
      awayFrom?: MachineRecord | undefined;
    }) => Promise<SessionHandle>;
    /**
     * Files that came with a comment, as a session takes them: where it can open them (a line for
     * each), the images among them as image input when its model takes them, and whether there
     * were images it was not shown (`Engine.filesFor`).
     */
    filesFor?: (
      files: readonly AttachmentRecord[],
      handle: SessionHandle,
      machine: MachineRecord,
    ) => Promise<{
      lines: Map<string, string>;
      images: PromptImage[];
      unseen: boolean;
    }>;
    /** The machine an agent works on in a project: its own when it is pinned, else the project's. */
    machineFor: (
      agent: NonNullable<ReturnType<AgentStore["get"]>>,
      projectMachineId: string,
    ) => MachineRecord | undefined;
  };
  /** The files people attach to comments, which a comment's `data.attachments` names. */
  attachments?: Pick<AttachmentStore, "carried"> | undefined;
  /** A way to run a script on a machine: this process's shell, or the daemon over the link. */
  transport: (machine: MachineRecord) => SshTransport;
  dataDir: string;
  /** The features that act around a run (memory, akhook), as they do around a reply. */
  hooks: RunHooks | undefined;
  /** These conversations' timelines moved. */
  changed: (conversations: readonly string[]) => void;
  /** Where a run on an external runtime leaves what its messages used. */
  usage?: Pick<TaskUsageStore, "fromTranscript"> | undefined;
  warn: (message: string) => void;
  /** Whether a finished task wakes its maker (`tasks.reactToResults`); asked at each `finish_task`. */
  reactToResults?: (() => boolean) | undefined;
  /** Captain makes tasks too, and its results are its own: it is never woken here. */
  isCaptain?: ((agentId: string) => boolean) | undefined;
}

/** What `finish_task` is told. */
export interface Submission {
  summary: string;
  /** Where the task goes: to review (the work is done) or `blocked` (the user must act). */
  status: Extract<BoardTaskStatus, "in_review" | "blocked">;
}

/**
 * Something said to a run: a comment's words, and the files that came with it (which the run is
 * handed as files, its images as images when its model takes them). `activityId` is the comment's,
 * which says so when its images could not be shown.
 */
interface Said {
  text: string;
  files?: AttachmentRecord[] | undefined;
  activityId?: string | undefined;
}

/** A run that is going, as far as this process knows. */
interface Live {
  handle?: SessionHandle | undefined;
  /** The machine its session is on, and the agent it is, once it has one: where files go. */
  machine?: MachineRecord | undefined;
  agentId?: string | undefined;
  /** Whether a turn of the session is in flight, which a comment can join. */
  inFlight: boolean;
  /** Comments that arrived when no turn was in flight; they go in with the next. */
  pending: Said[];
  /** The steers handed to the turn in flight, one after another, so they arrive in order. */
  steering: Promise<void>;
  /** The run has been told what was said on the task; anything said later waits for it or for the next. */
  read: boolean;
  /** The executor called `finish_task`; a mentioned agent answered in the thread. */
  reported: boolean;
  /** Why the session was stopped from outside, if it was. */
  stopped: "interrupt" | "closing" | undefined;
  /** What the session last said, for the features that remember. */
  said: string;
}

interface Ended {
  status: "completed" | "failed" | "interrupted";
  error?: string | undefined;
  failure?: RunFailureView | undefined;
}

const ACTIVITY_POLL_MS = 10_000;
const ACTIVITY_STREAM_STALE_MS = ACTIVITY_POLL_MS * 2;

export function streamActivityCoversPoll(
  lastStreamedAt: number,
  now: number,
): boolean {
  return (
    lastStreamedAt !== 0 && now - lastStreamedAt < ACTIVITY_STREAM_STALE_MS
  );
}

const NUDGE =
  "You stopped without calling finish_task. If the task is done, or you cannot go on without " +
  "the user, call finish_task now with a summary of where it stands; otherwise carry on.";

/**
 * How many comments wait for a run that has not started. A comment is a turn of the task, not a
 * queue with no end: what a run that finally starts is told is what people said lately.
 */
const PARK_LIMIT = 20;

/**
 * One line of work on a task: its executor's runs (`agentId` null) or a mentioned agent's. A run
 * waits for the previous run of its own lane, and what was said waits for the next one of it.
 */
interface Lane {
  taskId: string;
  agentId: string | null;
}

const laneKey = (lane: Lane): string =>
  lane.agentId === null ? lane.taskId : `${lane.taskId}:${lane.agentId}`;

/** Who a run's events are by: a mentioned agent's are its own; the executor's are the system's. */
const actorOf = (run: RunRecord): TaskActor | undefined =>
  run.agentId === null ? undefined : { kind: "agent", agentId: run.agentId };

/** The agents a comment mentions, as its data keeps them. */
const mentionsOf = (activity: TaskActivityView): string[] => {
  const raw = activity.data.mentions;
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : [];
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function failureFromThrown(error: unknown): RunFailureView | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  if (code === "ENOENT")
    return {
      code: "configuration_missing",
      attempt: 1,
      retryable: false,
      providerMessage: messageOf(error),
    };
  if (code === "EACCES" || code === "EPERM")
    return {
      code: "permission",
      attempt: 1,
      retryable: false,
      providerMessage: messageOf(error),
    };
  return undefined;
}

/**
 * Where a run works, in the words it is told. A run on another machine than the project's has no
 * project directory there: it is told where it starts and nothing it cannot know (its system prompt
 * says whose machine the context is).
 */
const workingIn = (
  cwd: string,
  branch: string | null,
  elsewhere: boolean,
): string =>
  elsewhere
    ? `You start in ${cwd}.`
    : branch === null
      ? `You work in the project's directory, ${cwd}, itself: your changes are made in place.`
      : `You work in ${cwd}, a git worktree of the project on the branch ${branch}. Commit your work there; the worktree stays after you finish, for the user to review.`;

export class TaskRunner implements TaskRuns {
  readonly #deps: TaskRunnerDeps;
  readonly #live = new Map<string, Live>();
  /** Comments waiting for the next run of a lane to read, oldest first, by `laneKey`. */
  readonly #waiting = new Map<string, { lane: Lane; texts: Said[] }>();
  readonly #work = new Set<Promise<void>>();
  #attached = false;
  #closing = false;
  /** `pump` is going; a call from inside it (a run ended, a task was blocked) asks for one more pass. */
  #pumping = false;
  #again = false;

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
    // A task with subtasks does not run itself: that is the design, not something to warn about.
    if (this.#deps.board.isParent(taskId)) return;
    try {
      this.#queue(taskId);
    } catch (error) {
      // A task that cannot run (no executor, no project) stays a note on the board.
      this.#deps.warn(
        `[eta] task ${taskId} was not queued: ${messageOf(error)}`,
      );
    }
  }

  /**
   * A new run of a task, in a session of its own that remembers nothing. Refused while the task has
   * a run that has not ended. What was said on the task and never got read still goes: a rerun
   * forgets what the executor did, not what was asked of it.
   */
  rerun(taskId: string): { task: BoardTaskDetail; run: RunRecord } {
    const task = this.#task(taskId);
    if (this.#openIn({ taskId: task.id, agentId: null }).length > 0)
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

  /** The task is done or cancelled: its runs stop, and so does anything waiting to wake one. */
  stop(taskId: string, why: string): void {
    this.#forget(taskId);
    for (const run of this.#deps.runs.openOf(taskId)) this.#stop(run, why);
  }

  /**
   * The task is finished, archived or deleted: take its worktree away if it is clean. A run still
   * winding down is waited for (a minute at most); a failure is only logged, since the files are
   * only tidied, never needed.
   */
  release(
    task: {
      id: string;
      projectId: string | null;
      worktreePath: string | null;
    },
    attempt = 0,
  ): void {
    if (task.worktreePath === null || task.projectId === null) return;
    if (this.active(task.id) && attempt < 12) {
      setTimeout(() => this.release(task, attempt + 1), 5000).unref();
      return;
    }
    const project = this.#deps.projects.get(task.projectId);
    const machine =
      project === undefined
        ? undefined
        : this.#deps.machines.get(project.machineId);
    if (project === undefined || machine === undefined) return;
    removeWorktree(this.#deps.transport(machine), {
      projectPath: project.path,
      path: task.worktreePath,
    }).catch((error: unknown) => {
      console.warn(
        `[eta] could not remove a task's worktree: ${messageOf(error)}`,
      );
    });
  }

  withdraw(taskId: string, which: "start" | "executor" = "start"): void {
    for (const run of this.#deps.runs.openOf(taskId))
      if (
        run.status === "queued" &&
        run.agentId === null &&
        (which === "executor" || run.waitsForDeps)
      )
        this.#stop(run);
  }

  active(taskId: string): boolean {
    return this.#deps.runs
      .openOf(taskId)
      .some((run) => run.status === "starting" || run.status === "running");
  }

  /**
   * A comment arrived on the task, and it is read: a run that is going gets it as a user message
   * and carries on; a task with no run going is woken by it, and the comment is what the run that
   * wakes it is asked to work on. Nothing is running that could read it and the task is not worked
   * on any more (`backlog`, `done`, `cancelled`) — then it is a line on the timeline and nothing
   * more.
   *
   * The agents a user's comment mentions are each woken in their own lane to answer it. The
   * executor is woken only by a comment meant for it: one that mentions it, or nobody; one that
   * mentions only others it reads if it is working. `wake: false` (a mentioned agent's answer)
   * wakes nobody at all.
   */
  deliver(
    taskId: string,
    activity: TaskActivityView,
    options: { wake?: boolean } = {},
  ): void {
    if (activity.body === null || activity.actor.kind === "system") return;
    const task = this.#deps.tasks.get(taskId);
    if (task === undefined) return;
    const who =
      activity.actor.kind === "user"
        ? "the user"
        : (this.#deps.agents.get(activity.actor.agentId ?? "")?.name ??
          "another agent");
    const said: Said = {
      text: `A comment from ${who} on task #${task.number}:\n\n${activity.body}`,
      files: this.#deps.attachments?.carried(activity.data) ?? [],
      activityId: activity.id,
    };
    const executor = this.#executorOf(task);
    // Only the user calls agents in: agents mentioning each other could wake one another forever.
    const mentions = activity.actor.kind === "user" ? mentionsOf(activity) : [];
    for (const agentId of mentions) {
      if (agentId === executor) continue;
      if (this.#deps.agents.get(agentId) === undefined) {
        this.#deps.warn(
          `[eta] task ${taskId} mentions agent ${agentId}, which is gone`,
        );
        continue;
      }
      this.#hand({ taskId, agentId }, said, true);
    }
    const forExecutor =
      options.wake !== false &&
      (mentions.length === 0 ||
        (executor !== null && mentions.includes(executor)));
    // Words left with a task that will not be worked on again are none of the runner's business,
    // and a task with subtasks is not worked on itself: a run of it that is going (an executor
    // splitting its task) still reads them, but nothing wakes one.
    this.#hand(
      { taskId, agentId: null },
      said,
      forExecutor &&
        workable(task.status) &&
        !this.#deps.board.isParent(task.id),
    );
  }

  /**
   * Hand words to a lane: into its run that is going (steering the turn in flight, or with the
   * next), or — when `wake` — left for its next run, which this asks for if none is waiting.
   */
  #hand(lane: Lane, said: Said, wake: boolean): void {
    const going = this.#openIn(lane).find(
      (run) => run.status === "starting" || run.status === "running",
    );
    const live = going === undefined ? undefined : this.#live.get(going.id);
    if (going !== undefined && live !== undefined) {
      if (live.inFlight && live.handle !== undefined) {
        const handle = live.handle;
        // In order: a comment with files is ready a moment later than one without.
        live.steering = live.steering.then(async () => {
          try {
            // The turn ended while an earlier one was put in: this one goes in with the next.
            if (!live.inFlight) throw new Error("the turn ended");
            const told = await this.#told(going.taskId, [said], live);
            await handle.steer(told.text, told.images);
          } catch (error) {
            // It could not join the turn (the turn ended under it): it goes in with the next.
            this.#deps.warn(
              `[eta] could not steer run ${going.id}: ${messageOf(error)}`,
            );
            live.pending.push(said);
          }
        });
      } else {
        live.pending.push(said);
      }
      return;
    }
    if (!wake) return;
    // Nobody is reading it now. Leave it with the lane and let the queue decide who reads it: the
    // run already waiting there, or one this comment has to ask for. For the executor that is a
    // continuation, not a restart: the task's session holds what it did, and the comment usually
    // reads as an answer to it. It waits its turn like any run (offline machine, a full machine)
    // and the comment waits with it. `pump` is where a parked comment turns into a run.
    this.#park(lane, said);
    this.pump();
  }

  /**
   * What a run is told of things said to it: their words, each followed by its files (where the
   * session can open them), and the images among the files when its model takes them. A comment
   * whose images it was not shown says so on the task's timeline.
   */
  async #told(
    taskId: string,
    said: readonly Said[],
    live: Live,
  ): Promise<{ text: string; images: PromptImage[] | undefined }> {
    const files = said.flatMap((item) => item.files ?? []);
    const { engine } = this.#deps;
    const handed =
      files.length === 0 ||
      engine.filesFor === undefined ||
      live.handle === undefined ||
      live.machine === undefined
        ? undefined
        : await engine.filesFor(files, live.handle, live.machine);
    if (handed?.unseen === true && live.agentId !== undefined)
      for (const item of said)
        if (
          item.activityId !== undefined &&
          (item.files ?? []).some((file) =>
            file.contentType.startsWith("image/"),
          )
        )
          this.#deps.board.imagesUnseen(taskId, item.activityId, live.agentId);
    const text = said
      .map((item) =>
        [
          item.text,
          ...(item.files ?? []).map(
            (file) =>
              handed?.lines.get(file.id) ?? `[attachment: ${file.name}]`,
          ),
        ].join("\n"),
      )
      .join("\n\n");
    const images = handed?.images ?? [];
    return { text, images: images.length > 0 ? images : undefined };
  }

  /**
   * Put a question to an agent in its lane of the task, as a mentioned agent is called in: it is
   * woken in a session of its own on the task and reads `text`.
   */
  consult(taskId: string, agentId: string, text: string): void {
    this.#hand({ taskId, agentId }, { text }, true);
  }

  /** The lane's runs that have not ended. */
  #openIn(lane: Lane): RunRecord[] {
    return this.#deps.runs
      .openOf(lane.taskId)
      .filter((run) => run.agentId === lane.agentId);
  }

  /** Everything left to read on a task, in every lane of it, goes. */
  #forget(taskId: string): void {
    for (const [key, { lane }] of this.#waiting)
      if (lane.taskId === taskId) this.#waiting.delete(key);
  }

  /**
   * Ask for a run of each task whose comments found nobody to read them. Part of `pump` because
   * that is where the answer to "should something run?" is worked out, and because there are
   * moments other than a comment that change it: a run ending, a machine coming back.
   */
  #wakeWaiting(): void {
    for (const [key, { lane, texts }] of [...this.#waiting]) {
      if (texts.length === 0) {
        this.#waiting.delete(key);
        continue;
      }
      // A run of the lane is in the queue or going: it will read what is waiting.
      if (this.#openIn(lane).length > 0) continue;
      const task = this.#deps.tasks.get(lane.taskId);
      // A mentioned agent answers whatever the task's status; the executor works only a workable one.
      if (
        task === undefined ||
        (lane.agentId === null && !workable(task.status))
      ) {
        this.#waiting.delete(key);
        continue;
      }
      try {
        // The words stay parked for that run to be told, so a wake that got as far as queueing has
        // its answer in the table and survives a restart; only a refusal empties the park.
        this.#queue(lane.taskId, { continues: true, agentId: lane.agentId });
      } catch (error) {
        this.#waiting.delete(key);
        this.#deps.warn(
          `[eta] task ${lane.taskId} was not woken by a comment: ${messageOf(error)}`,
        );
      }
    }
  }

  /** Leave a comment for the next run of the lane to be told. */
  #park(lane: Lane, said: Said): void {
    this.#parkAll(lane, [said]);
  }

  /** Leave several, in order, for the next run of the lane to be told. Nothing to tell is nothing to leave. */
  #parkAll(lane: Lane, texts: Said[]): void {
    if (texts.length === 0) return;
    const key = laneKey(lane);
    const waiting = [...(this.#waiting.get(key)?.texts ?? []), ...texts];
    this.#waiting.set(key, { lane, texts: waiting.slice(-PARK_LIMIT) });
  }

  /** The comments a run takes over as it starts. */
  #unpark(lane: Lane): Said[] {
    const key = laneKey(lane);
    const waiting = this.#waiting.get(key);
    this.#waiting.delete(key);
    return waiting?.texts ?? [];
  }

  /* ---------------------------------------------------------------- the executor's tools */

  /** The run a session works in, when it works in one. */
  runOf(runId: string): RunRecord | undefined {
    return this.#deps.runs.get(runId);
  }

  /**
   * The run of this task that is going now, which is what a session's tools speak for. A session is
   * the task's and outlives a run, so the tools of a session that was opened by an earlier run are
   * asked again each time, and answer with the run that is reading them.
   */
  workingRunOf(
    taskId: string,
    agentId: string | null = null,
  ): RunRecord | undefined {
    return this.#openIn({ taskId, agentId }).find(
      (run) => run.status === "starting" || run.status === "running",
    );
  }

  /**
   * A mentioned agent answers in the thread. The answer is a comment in its name that the
   * executor reads if it is working, and that wakes nobody. Returns what to tell the model.
   */
  answer(taskId: string, agentId: string, body: string): string {
    const run = this.workingRunOf(taskId, agentId);
    const live = run === undefined ? undefined : this.#live.get(run.id);
    if (run === undefined || live === undefined)
      throw new Error(
        "you are not answering on this task now, so there is nothing to answer",
      );
    const task = this.#task(taskId);
    this.#deps.board.comment(
      task.id,
      body,
      { kind: "agent", agentId },
      { wake: false },
    );
    live.reported = true;
    return `Your answer is in the thread of #${task.number}.`;
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
      agentId: this.#executorOf(task),
    };
    const summary = submission.summary.trim();
    if (summary === "") throw new Error("finish_task needs a summary");
    // The comment is the executor's own words: the run that wrote it does not read it back.
    this.#deps.board.comment(task.id, summary, executor, { deliver: false });
    // A task the executor split into subtasks takes its status from them, not from this run.
    const split = this.#deps.board.isParent(task.id);
    if (!split)
      this.#deps.board.update(task.id, { status: submission.status }, executor);
    live.reported = true;
    this.#post(task, executor, summary);
    // A mentioned agent's run answers in the thread; only the executor's run reports a result.
    if (run.agentId === null && !split)
      this.#wakeMaker(task, submission.status, summary);
    return split
      ? `Your summary is posted. Task #${task.number} has subtasks, so its status comes from them: it is [${this.#task(task.id).status}].`
      : `Task #${task.number} is now [${submission.status}] and your summary is posted.`;
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

  /**
   * With `tasks.reactToResults` on, the agent that made the task is woken once, in its lane, to
   * review the result. Nothing it says wakes anyone: its lane's answers are comments that wake nobody,
   * and only an executor's run reaches here. The user's tasks, the executor's own, Captain's and
   * tasks with no conversation to come back to are left as they are.
   */
  #wakeMaker(
    task: TaskRecord,
    status: Submission["status"],
    summary: string,
  ): void {
    const { agents } = this.#deps;
    const makerId = task.createdBy.agentId;
    if (
      this.#deps.reactToResults?.() !== true ||
      task.originConversationId === null ||
      makerId === null ||
      makerId === this.#executorOf(task) ||
      this.#deps.isCaptain?.(makerId) === true
    )
      return;
    const maker = agents.get(makerId);
    if (maker === undefined) return;
    const project =
      task.projectId === null
        ? undefined
        : this.#deps.projects.get(task.projectId);
    if (
      project !== undefined &&
      externalAgentProjectError(maker, project, this.#deps.machines) !==
        undefined
    )
      return;
    const executor = agents.get(this.#executorOf(task) ?? "")?.name;
    this.consult(
      task.id,
      makerId,
      [
        `This is not a comment from the user. ${executor ?? "The executor"} finished its work on task #${task.number}, "${task.title}", and you made the task, so the result comes to you first. The user is often away: follow it up yourself.`,
        `## Result (status: ${status === "blocked" ? "blocked: the user must act" : "in review"})\n\n${summary}`,
        `## What to do\n\n- Read the work (get_task shows the task and its timeline) and check it against what the task asked.\n- If it is good, say so in the thread; mark the task done if you may.\n- If it is not, comment on the task what is missing: that carries the executor on.\n- Tell the user only what needs their decision. A new task you draft is yours to weigh: each one runs on its own.`,
      ].join("\n\n"),
    );
  }

  /* ---------------------------------------------------------------- the queue */

  #task(taskId: string): TaskRecord {
    const task = this.#deps.tasks.find(taskId);
    if (task === undefined) throw new Error(`no such task: ${taskId}`);
    return task;
  }

  /**
   * The agent that executes a task: the assignee when one was named (a draft can be written on
   * someone else's behalf), else the maker. A task made before assignees existed has none, so it
   * keeps its maker, as it always was.
   */
  #executorOf(task: TaskRecord): string | null {
    return executorOf(task);
  }

  /**
   * Queue a run of a task, or say why it cannot have one. A run that continues the task carries on
   * in the session of the newest run that made one; a rerun and a task's first run open their own.
   */
  #queue(
    taskId: string,
    options: { continues?: boolean; agentId?: string | null } = {},
  ): RunRecord {
    const { runs, board, projects, agents } = this.#deps;
    const task = this.#task(taskId);
    const agentId = options.agentId ?? null;
    if (agentId !== null) {
      if (agents.get(agentId) === undefined)
        throw new Error(
          `the agent mentioned on this task (${agentId}) is not registered`,
        );
    } else {
      const executor = this.#executorOf(task);
      // A task the user made runs too, once it names its executor (`TaskBoard.make`).
      if (executor === null)
        throw new Error("this task has no executor: only an agent's task runs");
      if (board.isParent(task.id))
        throw new Error(
          `#${task.number} has subtasks: it does not run itself, and its status comes from them. Run or comment on a subtask instead`,
        );
      if (agents.get(executor) === undefined)
        throw new Error(executorGoneText(task));
    }
    const project =
      task.projectId === null ? undefined : projects.get(task.projectId);
    if (project === undefined)
      throw new Error("this task's project is gone, so it has nowhere to run");
    const continued =
      options.continues === true
        ? runs.lastSessionOf(task.id, agentId)
        : undefined;
    // The run is on the machine of the agent that works in it — the mentioned agent, else the
    // executor (the assignee before the maker) — external runtimes use only their pinned machine,
    // while eta agents fall back to the project's machine.
    const runner = agents.get(agentId ?? this.#executorOf(task) ?? "");
    const machineId =
      runner === undefined
        ? project.machineId
        : isExternalRuntime(runner.runtime)
          ? runner.machineId
          : (this.#deps.engine.machineFor(runner, project.machineId)?.id ??
            project.machineId);
    // The executor's run that starts the work (a first run, a rerun) waits for the task's
    // dependencies; one woken by a comment carries on work that started, and a mentioned agent
    // only answers.
    const run = runs.create(
      task.id,
      machineId,
      continued?.id ?? null,
      agentId,
      agentId === null && options.continues !== true,
    );
    board.runEvent(task.id, {
      kind: "run_queued",
      runId: run.id,
      actor: actorOf(run),
    });
    this.pump();
    return runs.get(run.id)!;
  }

  /**
   * Start the runs that can start. Cheap, and safe to call whenever anything may have changed,
   * from inside a pass too: such a call (a run withdrawn, a task blocked) asks for one more pass
   * after this one rather than a pass inside it.
   */
  pump(): void {
    if (!this.#attached || this.#closing) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        this.#pass();
      } while (this.#again && this.#attached && !this.#closing);
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * One look at the queue, oldest first. The order of the reasons is the order of the questions: is
   * the machine there, is the task's lane free, is what the task waits for resolved, is there a
   * slot. A run that waits for its dependencies takes no slot, so a later run whose are resolved
   * starts in its place.
   */
  #pass(): void {
    // A comment is such a moment: it is a request for the executor to look at the task again.
    this.#wakeWaiting();
    const { runs, machines, board } = this.#deps;
    const graph = board.graph();
    for (const run of runs.queued()) {
      const machine =
        run.machineId === null ? undefined : machines.get(run.machineId);
      if (run.agentId === null && graph.hasChildren(run.taskId)) {
        // A task with subtasks does not run itself; this run should have been withdrawn with it
        // (its `subtask` entries say why).
        this.withdraw(run.taskId, "executor");
        continue;
      }
      const gate = run.waitsForDeps ? graph.gate(run.taskId) : undefined;
      if (gate?.state === "broken") {
        // It will never start on its own: the board blocks the task and withdraws this run.
        board.blockOnCancelled(run.taskId);
        continue;
      }
      const task = this.#deps.tasks.get(run.taskId);
      const project =
        task?.projectId == null
          ? undefined
          : this.#deps.projects.get(task.projectId);
      const runnerAgent =
        task === undefined
          ? undefined
          : this.#deps.agents.get(run.agentId ?? this.#executorOf(task) ?? "");
      const boundProblem =
        runnerAgent !== undefined && project !== undefined
          ? (externalAgentProjectError(runnerAgent, project, machines) ??
            (isExternalRuntime(runnerAgent.runtime) &&
            run.machineId !== runnerAgent.machineId
              ? `${runnerAgent.name} runs on ${runnerAgent.runtime} and may only run on its pinned machine`
              : undefined))
          : undefined;
      if (boundProblem !== undefined) {
        if (runs.start(run.id)) {
          runs.finish(run.id, "failed", boundProblem);
          board.runEvent(run.taskId, {
            kind: "run_failed",
            runId: run.id,
            actor: actorOf(run),
            body: boundProblem,
          });
          this.#waiting.delete(laneKey(run));
        }
        continue;
      }
      let reason: TaskQueueReason | null = null;
      if (machine === undefined || machine.status !== "online")
        reason = "machine_offline";
      else if (runs.busy(run)) reason = "task_busy";
      else if (gate?.state === "waiting") reason = "waiting_deps";
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

  /**
   * Stop a run, saying why. A run withdrawn by the board has no words of its own (`why` absent):
   * the board's entry next to it says why, in the reader's language.
   */
  #stop(run: RunRecord, why?: string): void {
    const live = this.#live.get(run.id);
    if (live === undefined) {
      // It never started: it never will. Nothing is going to read what was left for it, and the
      // user asked for the task to stop, so the words stay on the timeline and the queue is clear.
      this.#waiting.delete(laneKey(run));
      if (
        this.#deps.runs.finish(run.id, "interrupted", why ?? null) !== undefined
      ) {
        this.#deps.board.runEvent(run.taskId, {
          kind: "run_interrupted",
          runId: run.id,
          body: why,
          actor: actorOf(run),
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
      steering: Promise.resolve(),
      read: false,
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
        ...(lost
          ? {
              failure: {
                code: "unknown_outcome",
                attempt: 1,
                retryable: false,
              },
            }
          : failureFromThrown(error)),
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
      ended.failure,
    );
    if (done !== undefined) {
      this.#deps.board.runEvent(run.taskId, {
        kind: `run_${ended.status}`,
        runId: run.id,
        actor: actorOf(run),
        ...(ended.error === undefined || ended.status === "completed"
          ? {}
          : { body: ended.error }),
      });
    }
    // What was said on the task and this run never told to anyone. A stop is a full stop, and a run
    // that died before it was briefed is not asked again by the same comment — a task that cannot
    // start would else wake itself forever. The words are on the task's timeline either way, and a
    // comment that arrives later asks again.
    if (live.stopped === undefined && live.read)
      this.#parkAll(run, live.pending.splice(0));
    else this.#waiting.delete(laneKey(run));
    this.#after(info, ended, live.said);
    // A comment left unread, a run that has now ended, a task still being worked on: that is a run.
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
    // The executor, or the agent this lane is: a mentioned agent answers, it does not execute.
    const mentioned = run.agentId !== null;
    const agentId = run.agentId ?? this.#executorOf(task);
    const agent = agentId === null ? undefined : agents.get(agentId);
    if (agent === undefined)
      return {
        ended: {
          status: "failed",
          error: mentioned
            ? `The agent mentioned on this task (${agentId}) is not registered.`
            : `${capitalized(executorGoneText(task))}.`,
        },
      };
    const project =
      task.projectId === null ? undefined : projects.get(task.projectId);
    if (project === undefined)
      return {
        ended: { status: "failed", error: "The task's project is gone." },
      };
    const boundProblem = externalAgentProjectError(
      agent,
      project,
      this.#deps.machines,
    );
    if (boundProblem !== undefined)
      return { ended: { status: "failed", error: boundProblem } };
    if (isExternalRuntime(agent.runtime) && machine.id !== agent.machineId)
      return {
        ended: {
          status: "failed",
          error: `${agent.name} runs on ${agent.runtime} and may only run on its pinned machine.`,
        },
      };

    // Where it works. A run on another machine than the project's (its agent is pinned there) has
    // no project directory to work in: it starts in that machine's home and is told so.
    const elsewhere = machine.id !== project.machineId;
    const awayFrom = elsewhere
      ? this.#deps.machines.get(project.machineId)
      : undefined;
    let cwd = elsewhere
      ? (machine.home ?? (machine.kind === "primary" ? homedir() : "/"))
      : project.path;
    let branch: string | null = null;
    if (task.workspaceMode === "worktree" && !elsewhere) {
      // The base is worked out now: one the task depends on may be done, and its branch gone.
      const { base, why } = board.baseFor(task);
      const made = await prepareWorktree(this.#deps.transport(machine), {
        projectPath: project.path,
        projectId: project.id,
        number: task.number,
        base,
        root:
          machine.kind === "primary"
            ? shellQuote(this.#deps.dataDir)
            : '"$HOME/.eta"',
      }).catch((error: unknown) => {
        if (why === undefined) throw error;
        throw new Error(
          `The worktree could not be made: ${why}. (${messageOf(error)})`,
        );
      });
      cwd = made.cwd;
      branch = made.branch;
      if (task.worktreePath !== made.path)
        board.setWorktree(task.id, made.path, made.branch);
    }
    if (live.stopped !== undefined) return { ended: { status: "interrupted" } };

    // The session: the one this run continues, or a new one of the agent — none of what it said in
    // the conversation. A session is the task's, so a continuation is told the key the session was
    // made under, which is what the machine holding it files its journal, prompt and tools under.
    const continued =
      run.continuesRunId === null ? undefined : runs.get(run.continuesRunId);
    // The session lives on the machine it was made on; a task whose project moved does not reach
    // for one that is no longer there — it starts afresh.
    const reused =
      continued?.sessionId == null || continued.machineId !== run.machineId
        ? undefined
        : continued;
    const key =
      reused !== undefined
        ? sessionKeyOf(reused)
        : run.agentId === null
          ? taskKey(task.id)
          : mentionKey(task.id, run.agentId);
    const handle = await this.#deps.engine.openRunSession({
      key,
      existing: reused?.sessionId ?? null,
      title: `#${task.number} ${task.title}`,
      agent,
      machine,
      cwd,
      created: (sessionId) => runs.setSession(run.id, sessionId, cwd, key),
      awayFrom,
    });
    runs.setSession(run.id, handle.id, cwd, key);
    live.machine = machine;
    live.agentId = agent.id;
    // Whether there is something to carry on from: a session whose journal was lost comes back as a
    // new one, and a run with nothing above it is told the whole brief again.
    const carriesOn = reused !== undefined && handle.id === reused.sessionId;
    live.handle = handle;
    if (live.stopped !== undefined) return { ended: { status: "interrupted" } };

    runs.running(run.id);
    if (!mentioned && task.status !== "in_progress" && !board.isParent(task.id))
      board.update(
        task.id,
        { status: "in_progress" },
        { kind: "system", agentId: null },
      );
    board.runEvent(task.id, {
      kind: "run_started",
      runId: run.id,
      data: { workspace: cwd },
      actor: actorOf(run),
    });

    // What was said on the task: while the session was being made, and (for a run woken by a
    // comment, or queued while comments arrived) whatever waited for this run to start. From here
    // on, anything said is this run's to read or the next one's.
    const words = [...this.#unpark(run), ...live.pending.splice(0)];
    live.read = true;
    const told = mentioned
      ? // The work is in the project, whichever machine this agent answers from.
        this.#mentionedOf(
          task,
          agent.name,
          elsewhere ? project.path : cwd,
          branch,
          carriesOn,
        )
      : carriesOn === true
        ? this.#carryOnOf(task, cwd, branch, words.length > 0, elsewhere)
        : this.#promptOf(task, cwd, branch, elsewhere);
    const conversationId = task.originConversationId ?? key;
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
    let images: PromptImage[] | undefined;
    if (words.length > 0) {
      const said = await this.#told(task.id, words, live);
      prompt = `${prompt}\n\n${said.text}`;
      images = said.images;
    }

    for (;;) {
      if (live.stopped !== undefined)
        return { ended: { status: "interrupted" }, info };
      live.inFlight = true;
      const stopActivity = this.#watchActivity(run.id, handle);
      let result;
      try {
        result = await handle.run(prompt, () => !this.#closing, images);
      } finally {
        stopActivity();
        live.inFlight = false;
      }
      // A steer still being put together lands in `pending` now, for the next turn.
      await live.steering;
      // Before the run can end: it ends with these counted, and its end is what tells the clients.
      if (result.usage !== undefined) {
        try {
          this.#deps.usage?.fromTranscript(run, result.usage);
        } catch (error) {
          this.#deps.warn(
            `[eta] could not count what run ${run.id} used: ${messageOf(error)}`,
          );
        }
      }
      if (result.text.trim() !== "") live.said = result.text;
      if (live.stopped !== undefined || result.status === "aborted")
        return { ended: { status: "interrupted" }, info };
      if (result.status === "failed")
        return {
          ended: {
            status: "failed",
            error:
              result.error === undefined
                ? "The run failed."
                : explainRunError(result.error),
            failure: result.failure,
          },
          info,
        };
      // Comments that came while the turn was ending go in with the next.
      if (live.pending.length > 0) {
        ({ text: prompt, images } = await this.#told(
          task.id,
          live.pending.splice(0),
          live,
        ));
        continue;
      }
      if (mentioned) {
        // An answer that never went to the thread goes there now: what it said last is it.
        if (!live.reported && live.said.trim() !== "")
          board.comment(
            task.id,
            live.said,
            { kind: "agent", agentId: agent.id },
            { wake: false },
          );
        return { ended: { status: "completed" }, info };
      }
      if (live.reported) return { ended: { status: "completed" }, info };
      const current = runs.get(run.id);
      if (current?.nudged !== true) {
        runs.nudged(run.id);
        board.runEvent(task.id, { kind: "run_nudged", runId: run.id });
        prompt = NUDGE;
        images = undefined;
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
  #promptOf(
    task: TaskRecord,
    cwd: string,
    branch: string | null,
    elsewhere: boolean,
  ): string {
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
      `## Where you work\n\n${workingIn(cwd, branch, elsewhere)}`,
      `## Reporting\n\n- comment_task posts a progress note or a question on the task.\n- When the work is done, or you cannot go on without the user, call finish_task with a summary: what you did, the result, and what the user should check. It moves the task to review and posts the summary in the conversation. A run that stops without calling it is reminded once, then fails.\n- The user may comment on the task while you work; their comments reach you as messages, and a comment left once this run has ended wakes another one, in this session. Other agents the user mentions on the task answer in its thread; their answers reach you while you work.\n- Merging (opening a pull request) is decided after review: do not merge into the main branch unless the task says to.\n- get_task shows the whole task with its timeline.`,
    ]
      .filter((part) => part !== undefined)
      .join("\n\n");
  }

  /**
   * What a run that continues the task's session is told instead of the brief: the task and the
   * project are already above it, so it is told where the task stands now, that what was said on it
   * follows below, and how to report again. Repeating the brief would only bury the comment it is
   * here for. Nothing below it happens when the host was restarted between the comment and this
   * run — what is left to read is on the task, and it is told to look.
   */
  #carryOnOf(
    task: TaskRecord,
    cwd: string,
    branch: string | null,
    hasWords: boolean,
    elsewhere: boolean,
  ): string {
    const standing: Record<string, string> = {
      in_review:
        "It is in review: you reported it, and what follows is the user's answer to that — a change " +
        "they want on top of what you did, or the thing you asked them for.",
      blocked:
        "You stopped because you needed the user. What follows is what they said, which may be the " +
        "answer you were waiting for.",
    };
    return [
      `You are the executor of task #${task.number}, "${task.title}", again. This is the session your earlier run worked in: what you read, changed and reported above is your own work, and the task came back to you because something was said on it.`,
      `## Where the task stands\n\n${
        standing[task.status] ??
        `It is [${task.status}] and being worked on: what follows is what people on the task want of it now.`
      }\n\nRead what is above before you read the project again, and do not redo what you already did. get_task shows the whole task with its timeline, including anything changed since you were first briefed.`,
      `## Where you work\n\n${workingIn(cwd, branch, elsewhere)}`,
      `## Reporting\n\n- comment_task posts a progress note or a question on the task.\n- When this round is done, or you cannot go on without the user, call finish_task with a summary: what you did, the result, and what the user should check. It moves the task to review and posts the summary in the conversation. A run that stops without calling it is reminded once, then fails.\n- Merging (opening a pull request) is decided after review: do not merge into the main branch unless the task says to.`,
      hasWords
        ? "What was said on the task is below."
        : "Nothing was left for you to read below it: open get_task, and answer what its timeline last asked of the task.",
    ].join("\n\n");
  }

  /**
   * What a mentioned agent is told: whose task it is, that it is asked for its view and not to take
   * the work over, where the work is, and how to answer. The comment that called it in follows.
   */
  #mentionedOf(
    task: TaskRecord,
    name: string,
    cwd: string,
    branch: string | null,
    carriesOn: boolean,
  ): string {
    const executor =
      this.#executorOf(task) === null
        ? undefined
        : this.#deps.agents.get(this.#executorOf(task)!)?.name;
    return [
      carriesOn
        ? `You were mentioned on task #${task.number}, "${task.title}", again. This is the session you answered in before: what is above is your own reading and your own answers.`
        : `You are ${name}, and you were mentioned on task #${task.number}, "${task.title}". ${executor === undefined ? "Another agent" : executor} is its executor and does the work; the user asked for you in the task's thread. You are not taking the task over: read it, look at the work if that helps, and answer.`,
      carriesOn
        ? undefined
        : `## The task\n\n${task.description.trim() === "" ? "(no description)" : task.description.trim()}`,
      `## Where the work is\n\n${cwd}${branch === null ? "" : ` (the branch ${branch})`}. The executor works there too: change nothing unless the comment asks you to.`,
      `## Answering\n\n- comment_task posts your answer in the task's thread, in your name; the user and the executor read it there. When you have answered, stop: there is nothing to finish, and you are woken again in this session the next time you are mentioned.\n- If you stop without comment_task, what you said last is posted as your answer.\n- get_task shows the whole task with its timeline.`,
      "What you were asked is below.",
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

  #watchActivity(runId: string, handle: SessionHandle): () => void {
    let stopped = false;
    let seen = -1;
    let lastStreamedAt = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      if (!stopped) this.#deps.runs.touch(runId);
    };
    const off = handle.onActivity?.(() => {
      // Only a new event is progress. An in-flight tool that never updates is exactly the silent
      // hang the Supervisor needs to catch, so the start event must not keep renewing the run.
      lastStreamedAt = Date.now();
      touch();
    });
    // Starting the run is itself progress. Until an activity stream proves it is available, the
    // sequence poll below remains the fallback for daemons and session hosts that cannot stream.
    touch();
    let look: () => Promise<void>;
    const schedule = (delay: number): void => {
      if (stopped) return;
      timer = setTimeout(() => void look(), delay);
      timer.unref?.();
    };
    look = async (): Promise<void> => {
      if (stopped) return;
      let delay = ACTIVITY_POLL_MS;
      try {
        if (streamActivityCoversPoll(lastStreamedAt, Date.now())) {
          // The session's event stream is live: polling another machine's journal would only add
          // an RPC every ten seconds while the stream already carries the liveness evidence.
        } else {
          // A dead event stream must not disable the fallback permanently.
          lastStreamedAt = 0;
          const seq = await handle.lastSeq();
          if (stopped) return;
          if (seq > seen) {
            seen = seq;
            touch();
          }
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        delay = Math.min(
          5 * 60_000,
          ACTIVITY_POLL_MS * 2 ** Math.min(failures - 1, 6),
        );
        if (failures === 1 || (failures & (failures - 1)) === 0)
          this.#deps.warn(
            `[eta] could not read run activity (failure ${failures}): ${messageOf(error)}`,
          );
      }
      schedule(delay);
    };
    schedule(ACTIVITY_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      off?.();
    };
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
