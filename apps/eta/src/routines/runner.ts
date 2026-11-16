/**
 * Running a routine: one new Captain session with a brief and nobody watching, and revising the
 * brief from what the user says about a report.
 *
 * A run is Captain's. It is a session made the way Captain's other sessions are, through the
 * engine (`RoutineCaptain.open`, which is `Engine.openRunSession`): Captain's model, instructions
 * and every Captain tool, plus this routine's own (`tools.ts`). It is held in `routine:<runId>`
 * (`session-owner.ts`) and works in a directory of the routine's own (`<dataDir>/routines/<id>/`).
 * The rules:
 *
 * - **Captain off, no run.** A time that comes while Captain is off (its supervisor switched off,
 *   or no model) is written as a `skipped` run that says why, and nothing starts. Times missed
 *   that way are not made up when Captain is back.
 * - **A run tells the user something or fails.** `report` or `no_news` decides. A run that stops
 *   without either is asked once more; if it still says nothing, it has failed. What it said in
 *   passing is never taken for a report: that is how a note to itself would reach the user.
 * - **The handoff is the next run's alone.** It is kept in the row and put in the next run's prompt,
 *   and nowhere else: the user is told of a report in Captain's chat, by its title and a link.
 * - **A run does not run forever.** Fifteen minutes, then it is a failure that says so; a run that
 *   hangs would hold its routine's one slot for good.
 * - **One run at a time per routine**, which the schema enforces (`store.startRun`).
 * - **Feedback revises the brief, in the background**, on Captain's model. One pass at a time per
 *   routine; a revision reads the brief it will replace, and if that moved while the model was
 *   thinking it starts again from the newer text instead of overwriting it.
 * - **A restart settles what it interrupted.** Runs that were going are failed at startup
 *   (`store.recover`); feedback that was being revised is still pending and is picked up again
 *   when the runner is attached.
 */
import type {
  RoutinesStatus,
  RunTrigger,
  RunOutcome as SessionOutcome,
} from "@eta/client-contracts";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession, SessionMeta, SessionsService } from "@eta/server";
import type { SessionHandle } from "../conversations/places";
import type {
  FeedbackRecord,
  RoutineRecord,
  RoutineStore,
  RunOutcome,
  RunRecord,
} from "./store";
import type { Said } from "./tools";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { kernelOn } from "@eta/core";
import { ownerOf, routineKey } from "../session-owner";
import { nudgePrompt, revisionPrompt, runPrompt } from "./prompts";
import { routineTools } from "./tools";

/** What a run says when the process died under it. */
export const INTERRUPTED = "The server restarted before this run finished.";

/** Why a time that came while Captain was off made no run. */
function skippedBecause(status: RoutinesStatus): string {
  switch (status.reason) {
    case "no_model":
      return "Captain is off (it has no model), so this run did not happen.";
    case "no_captain":
      return "Captain is off (it is not set up), so this run did not happen.";
    default:
      return "Captain is off (its supervisor is switched off), so this run did not happen.";
  }
}

const RUN_TIMEOUT_MS = 15 * 60_000;
const REVISE_TIMEOUT_MS = 2 * 60_000;
/** How many times a revision starts again because the brief moved under it. */
const REVISE_TRIES = 3;

/** The directory under which every routine has one of its own. */
const homesIn = (dataDir: string): string => join(dataDir, "routines");

/** A routine's working directory: where its runs work, and what marks a revision's session as its. */
function routineHome(dataDir: string, routineId: string): string {
  return join(homesIn(dataDir), routineId);
}

/** What the runner needs of Captain, who does the runs. */
export interface RoutineCaptain {
  /** Whether Captain is on to run routines, and why not. */
  status: () => RoutinesStatus;
  /** Captain's model, for a revision of a brief; undefined when it has none. */
  model: () => string | undefined;
  /** Whether a session's agent is Captain. */
  is: (agentId: string | undefined) => boolean;
  /** A new Captain session for a run, held in `key`, the way the engine makes Captain's sessions. */
  open: (input: {
    key: string;
    title: string;
    cwd: string;
    created: (sessionId: string) => void;
  }) => Promise<SessionHandle>;
  /** A run sent a report: tell the user where they talk to Captain. Its title and a link, no more. */
  reported: (routine: RoutineRecord, run: RunRecord) => Promise<void>;
}

export interface RunnerOptions {
  store: RoutineStore;
  captain: RoutineCaptain;
  dataDir: string;
  now?: (() => number) | undefined;
  /** How long a run may take. */
  timeoutMs?: number | undefined;
  /** How long one revision of a brief may take. */
  reviseTimeoutMs?: number | undefined;
  /** Say that a routine's state moved. */
  changed: (routineId: string) => void;
  warn: (message: string) => void;
}

/** A run that is going, as far as its tools are concerned. */
interface Active {
  said?: Said;
  handoff?: string;
}

/** Why a session was stopped from outside, if it was. */
type Stopped = "closing" | "timeout" | undefined;

export class RoutineRunner {
  readonly #store: RoutineStore;
  readonly #captain: RoutineCaptain;
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #reviseTimeoutMs: number;
  readonly #changed: RunnerOptions["changed"];
  readonly #warn: (message: string) => void;

  #sessions: SessionsService | undefined;
  #closing = false;
  /** The runs that are going, by run id. */
  readonly #active = new Map<string, Active>();
  /** What stops each session that is working for the runner (a run or a revision). */
  readonly #aborts = new Set<() => void>();
  readonly #runs = new Set<Promise<void>>();
  /** The revision pass of each routine that has one, so the passes of a routine are one after another. */
  readonly #revisions = new Map<string, Promise<void>>();

  constructor(options: RunnerOptions) {
    this.#store = options.store;
    this.#captain = options.captain;
    this.#dataDir = options.dataDir;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    this.#reviseTimeoutMs = options.reviseTimeoutMs ?? REVISE_TIMEOUT_MS;
    this.#changed = options.changed;
    this.#warn = options.warn;
  }

  /** The session host this runner works on; set when the plugin is applied. */
  attach(sessions: SessionsService): void {
    this.#sessions = sessions;
    this.#closing = false;
    // A revision a restart interrupted is still pending in the rows. Pick it up again.
    for (const routineId of new Set(
      this.#store.pendingFeedback().map((feedback) => feedback.routineId),
    ))
      this.reviseSoon(routineId);
  }

  /**
   * Stop starting things and let the ones under way go: runs are aborted and end as failures that
   * say the server restarted; revisions are abandoned and stay pending. Resolves when nothing of
   * this runner is working.
   */
  async detach(): Promise<void> {
    this.#closing = true;
    for (const abort of this.#aborts) abort();
    await Promise.allSettled([...this.#runs, ...this.#revisions.values()]);
    this.#sessions = undefined;
  }

  /* ---------------------------------------------------------------- tools */

  /**
   * The routine tools of a run's session: a Captain session held in a run's key. Any other session
   * is not one of ours, and a run's session opened again after its run ended gets none.
   */
  readonly sessionTools = (input: { meta: SessionMeta }): KernelTool[] => {
    const owner = ownerOf(input.meta.conversationId);
    if (owner?.kind !== "routine" || !this.#captain.is(input.meta.agentId))
      return [];
    const runId = owner.runId;
    const run = this.#store.run(runId);
    if (run === undefined) return [];
    return routineTools({
      store: this.#store,
      routineId: run.routineId,
      run: {
        say: (said) => {
          const active = this.#active.get(runId);
          if (active === undefined) return "This routine run is over.";
          if (active.said !== undefined)
            return active.said.kind === "report"
              ? "This run already sent its report. A run reports once."
              : "This run already said there was no news.";
          active.said = said;
          return undefined;
        },
        handoff: (notes) => {
          const active = this.#active.get(runId);
          if (active === undefined) return "This routine run is over.";
          active.handoff = notes;
          return undefined;
        },
      },
    });
  };

  /**
   * The routine a session works for (a run, or a revision of its brief), if it works for one: for
   * counting what it costs.
   */
  readonly routineOf = (
    meta: Pick<SessionMeta, "cwd" | "conversationId">,
  ): string | undefined => {
    const owner = ownerOf(meta.conversationId);
    if (owner?.kind === "routine")
      return this.#store.run(owner.runId)?.routineId;
    if (dirname(meta.cwd) !== homesIn(this.#dataDir)) return undefined;
    const routineId = basename(meta.cwd);
    return this.#store.get(routineId) === undefined ? undefined : routineId;
  };

  /* ---------------------------------------------------------------- runs */

  /** Whether Captain is on to run routines. */
  status(): RoutinesStatus {
    return this.#captain.status();
  }

  /**
   * The clock says a routine is due. With Captain on, a run starts (true); with Captain off, the
   * time is written down as a skipped run and nothing starts (false).
   */
  fire(routineId: string): boolean {
    if (this.#closing || this.#store.get(routineId) === undefined) return false;
    const status = this.#captain.status();
    if (!status.captainOn) {
      this.#store.skipRun(routineId, "schedule", skippedBecause(status));
      this.#changed(routineId);
      return false;
    }
    return this.start(routineId, "schedule") !== undefined;
  }

  /**
   * Start a run of a routine now. The run goes on after this returns. Nothing starts, and nothing
   * is returned, when the routine has a run going already, Captain is off, or the runner is not
   * taking runs.
   */
  start(routineId: string, startedBy: RunTrigger): RunRecord | undefined {
    const routine = this.#store.get(routineId);
    if (
      this.#sessions === undefined ||
      this.#closing ||
      routine === undefined ||
      !this.#captain.status().captainOn
    )
      return undefined;
    const run = this.#store.startRun(routineId, startedBy);
    if (run === undefined) return undefined;
    this.#changed(routineId);
    const task = this.#execute(routine, run).catch((error: unknown) => {
      this.#warn(
        `[eta] routine ${routineId}: run ${run.id} could not be settled: ${messageOf(error)}`,
      );
    });
    this.#runs.add(task);
    void task.finally(() => this.#runs.delete(task));
    return run;
  }

  async #execute(routine: RoutineRecord, run: RunRecord): Promise<void> {
    const active: Active = {};
    this.#active.set(run.id, active);
    let outcome: RunOutcome;
    let sessionId: string | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = (): Stopped =>
      this.#closing ? "closing" : timedOut ? "timeout" : undefined;
    try {
      const cwd = routineHome(this.#dataDir, routine.id);
      await mkdir(cwd, { recursive: true });
      const previous = this.#store
        .runs(routine.id, 2)
        .find((other) => other.id !== run.id);
      const handle = await this.#captain.open({
        key: routineKey(run.id),
        title: `${routine.name} (routine run)`,
        cwd,
        created: (id) => {
          sessionId = id;
          this.#store.setRunSession(run.id, id);
          this.#changed(routine.id);
        },
      });
      sessionId = handle.id;
      this.#store.setRunSession(run.id, handle.id);
      this.#changed(routine.id);
      abort = () => handle.abort();
      this.#aborts.add(abort);
      timer = setTimeout(() => {
        timedOut = true;
        handle.abort();
      }, this.#timeoutMs);
      const keepGoing = (): boolean => stopped() === undefined;
      let result = await handle.run(
        runPrompt({
          name: routine.name,
          schedule: routine.schedule,
          timezone: routine.timezone,
          now: this.#now(),
          previousRunAt: previous?.startedAt,
          brief: this.#store.brief(routine.id)!,
          handoff: this.#store.handoff(routine.id),
        }),
        keepGoing,
      );
      // Stopped without telling the user anything: asked once more, then it has failed.
      if (
        active.said === undefined &&
        stopped() === undefined &&
        result.status === "completed"
      )
        result = await handle.run(nudgePrompt(), keepGoing);
      outcome = this.#outcomeOf(active, stopped(), result);
    } catch (error) {
      // The session could not be made or run at all. What was already recorded still says how the
      // run meant to end.
      outcome =
        active.said !== undefined
          ? saidOutcome(active)
          : {
              status: "failed",
              error: messageOf(error),
              ...(active.handoff === undefined
                ? {}
                : { handoff: active.handoff }),
            };
    } finally {
      clearTimeout(timer);
      if (abort !== undefined) this.#aborts.delete(abort);
      this.#active.delete(run.id);
    }
    // Put away before the row says the run is over, so whoever sees it over finds it put away.
    if (sessionId !== undefined) await this.#putAway(sessionId);
    const ended = this.#store.finishRun(run.id, outcome);
    this.#changed(routine.id);
    if (ended?.status === "sent")
      await this.#captain.reported(routine, ended).catch((error: unknown) => {
        this.#warn(
          `[eta] routine ${routine.id}: the report could not be announced: ${messageOf(error)}`,
        );
      });
  }

  /** How a run ended, from what its session did. */
  #outcomeOf(
    active: Active,
    stopped: Stopped,
    result: Pick<SessionOutcome, "status" | "error">,
  ): RunOutcome {
    // What it told the user is the run's own word and counts however the loop ended after it.
    if (active.said !== undefined) return saidOutcome(active);
    const handoff =
      active.handoff === undefined ? {} : { handoff: active.handoff };
    if (stopped === "closing")
      return { status: "failed", error: INTERRUPTED, ...handoff };
    if (stopped === "timeout")
      return {
        status: "failed",
        error: `The run took longer than ${describeLimit(this.#timeoutMs)} and was stopped.`,
        ...handoff,
      };
    if (result.status === "aborted")
      return { status: "failed", error: "The run was stopped.", ...handoff };
    if (result.status === "failed")
      return {
        status: "failed",
        error: result.error ?? "The run failed.",
        ...handoff,
      };
    return {
      status: "failed",
      error: "The run ended without calling report or no_news.",
      ...handoff,
    };
  }

  /** A run's session stays on disk for anyone who wants to read what it did, but not in the sidebar. */
  async #putAway(sessionId: string): Promise<void> {
    const sessions = this.#sessions;
    if (sessions === undefined) return;
    await sessions
      .setMeta(sessionId, { archived: true })
      .then(() => sessions.close(sessionId))
      .catch((error: unknown) => this.#warn(`[eta] ${messageOf(error)}`));
  }

  /* ---------------------------------------------------------------- feedback */

  /** Revise the routine's brief from the feedback that is waiting, after any pass already going. */
  reviseSoon(routineId: string): void {
    const before = this.#revisions.get(routineId) ?? Promise.resolve();
    const pass = before
      .then(() => this.#revisePending(routineId))
      .catch((error: unknown) => {
        this.#warn(
          `[eta] routine ${routineId}: a revision failed: ${messageOf(error)}`,
        );
      });
    this.#revisions.set(routineId, pass);
    void pass.finally(() => {
      if (this.#revisions.get(routineId) === pass)
        this.#revisions.delete(routineId);
    });
  }

  async #revisePending(routineId: string): Promise<void> {
    for (;;) {
      const feedback = this.#store.pendingFeedback(routineId)[0];
      if (feedback === undefined || this.#closing) return;
      // Each pass ends the feedback one way or the other (a version, or a failure on record),
      // except when the server is going down, which leaves it pending for the next start.
      if (!(await this.#reviseFrom(feedback))) return;
    }
  }

  /** Make one piece of feedback into a version of the brief. False when the server went down first. */
  async #reviseFrom(feedback: FeedbackRecord): Promise<boolean> {
    const sessions = this.#sessions;
    const fail = (why: string): boolean => {
      this.#warn(
        `[eta] routine ${feedback.routineId}: feedback ${feedback.id} could not be made into a brief: ${why}`,
      );
      this.#store.failRevision(feedback.id);
      this.#changed(feedback.routineId);
      return true;
    };
    for (let attempt = 0; attempt < REVISE_TRIES; attempt++) {
      const routine = this.#store.get(feedback.routineId);
      const current = this.#store.brief(feedback.routineId);
      const run = this.#store.run(feedback.runId);
      // Deleted while it was being thought about: nothing to revise.
      if (routine === undefined || current === undefined || run === undefined)
        return true;
      if (sessions === undefined || this.#closing) return false;
      let revised: string;
      try {
        revised = await this.#ask(
          sessions,
          routine,
          revisionPrompt({
            brief: current.text,
            run: run.report ?? run.error ?? "(it sent nothing)",
            feedback: feedback.text,
          }),
        );
      } catch (error) {
        if (this.#closing) return false;
        return fail(messageOf(error));
      }
      if (this.#closing) return false;
      if (revised.trim() === "") return fail("the model answered with nothing");
      const written = this.#store.reviseBrief({
        routineId: routine.id,
        feedbackId: feedback.id,
        text: revised.trim(),
        basedOn: current.version,
      });
      if (written !== undefined) {
        this.#changed(routine.id);
        return true;
      }
      // The brief moved while the model was answering: go round again from the newer text.
    }
    return fail("the brief kept changing while it was being revised");
  }

  /** One question to the routine's model, and what it answers. */
  #ask(
    sessions: SessionsService,
    routine: RoutineRecord,
    prompt: string,
  ): Promise<string> {
    return this.#inSession(
      sessions,
      routine,
      `${routine.name} (revising the brief)`,
      this.#reviseTimeoutMs,
      async (managed, _id, stopped) => {
        const heard = listen(managed);
        try {
          managed.session.kernel.nextRun({
            role: "user",
            timestamp: this.#now(),
            content: [{ type: "text", text: prompt }],
          });
          const result = await managed.session.runner.run();
          if (stopped() === "timeout")
            throw new Error(
              `took longer than ${describeLimit(this.#reviseTimeoutMs)}`,
            );
          if (result.status === "failed")
            throw new Error(result.error ?? "the model failed");
          if (result.status === "aborted") throw new Error("was stopped");
          return heard.said();
        } finally {
          heard.stop();
        }
      },
    );
  }

  /* ---------------------------------------------------------------- sessions */

  /**
   * A session for the routine's model in its directory, for as long as `work` takes. It is
   * stopped when the time is up or the runner is detached (`stopped` says which), and afterwards
   * closed and put away: it stays on disk for anyone who wants to read what the run did, but not
   * in the sidebar.
   */
  async #inSession<T>(
    sessions: SessionsService,
    routine: RoutineRecord,
    title: string,
    limitMs: number,
    work: (
      managed: ManagedSession,
      sessionId: string,
      stopped: () => Stopped,
    ) => Promise<T>,
  ): Promise<T> {
    // A routine is Captain's, and so is the model that revises its brief.
    const model = this.#captain.model();
    if (model === undefined)
      throw new Error("Captain has no model to revise the brief with.");
    const cwd = routineHome(this.#dataDir, routine.id);
    await mkdir(cwd, { recursive: true });
    const sessionId = await sessions.create({ cwd, title, model });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const { managed } = await sessions.open(sessionId);
      abort = () => managed.session.runner.abort();
      this.#aborts.add(abort);
      timer = setTimeout(() => {
        timedOut = true;
        managed.session.runner.abort();
      }, limitMs);
      return await work(managed, sessionId, () =>
        this.#closing ? "closing" : timedOut ? "timeout" : undefined,
      );
    } finally {
      clearTimeout(timer);
      if (abort !== undefined) this.#aborts.delete(abort);
      await sessions
        .setMeta(sessionId, { archived: true })
        .then(() => sessions.close(sessionId))
        .catch((error: unknown) => this.#warn(`[eta] ${messageOf(error)}`));
    }
  }
}

/** What the run told the user, as the outcome it makes, with its note for the next run. */
function saidOutcome(active: Active): RunOutcome {
  const handoff =
    active.handoff === undefined ? {} : { handoff: active.handoff };
  return active.said?.kind === "report"
    ? {
        status: "sent",
        report: active.said.body,
        title: active.said.title,
        ...handoff,
      }
    : { status: "no_news", ...handoff };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A time limit as a person says it. */
function describeLimit(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
}

/** The text of the last assistant message that had any: what the session said, in the end. */
function listen(managed: ManagedSession): {
  said: () => string;
  stop: () => void;
} {
  let said = "";
  const off = kernelOn(managed.session.kernel.ctx)(
    "message:end",
    ({ message }: { message: AgentMessage }) => {
      if (message.role !== "assistant") return;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const spoken = blocks
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("");
      if (spoken.trim() !== "") said = spoken;
    },
  );
  return { said: () => said, stop: () => void off() };
}
