import type { RunTrigger } from "@eta/client-contracts";
/**
 * Running a routine: one short session with a brief and nobody watching, and revising the brief
 * from what the user says about a report.
 *
 * A run is an ordinary upstream session, made for the purpose in a directory of the routine's own
 * (`<dataDir>/routines/<routineId>/`, which is also how `sessionTools` knows whose it is). The
 * rules, kept from the service this replaces:
 *
 * - **A run reports or says nothing.** `finish` decides; a run that ends without calling it sends
 *   its last message as the report, and one that said nothing at all has failed.
 * - **A run does not run forever.** Fifteen minutes, then it is a failure that says so; a run that
 *   hangs would hold its routine's one slot for good.
 * - **One run at a time per routine**, which the schema enforces (`store.startRun`).
 * - **Feedback revises the brief, in the background.** One pass at a time per routine; a revision
 *   reads the brief it will replace, and if that moved while the model was thinking it starts again
 *   from the newer text instead of overwriting it.
 * - **A restart settles what it interrupted.** Runs that were going are failed at startup
 *   (`store.recover`); feedback that was being revised is still pending and is picked up again
 *   when the runner is attached.
 */
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession, SessionMeta, SessionsService } from "@eta/server";
import type { Timeline } from "../conversations/timeline";
import type {
  FeedbackRecord,
  RoutineRecord,
  RoutineStore,
  RunOutcome,
  RunRecord,
} from "./store";
import type { Finish } from "./tools";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { kernelOn } from "@eta/core";
import { revisionPrompt, runPrompt } from "./prompts";
import { routineTools } from "./tools";

/** What a run says when the process died under it. */
export const INTERRUPTED = "The server restarted before this run finished.";

const RUN_TIMEOUT_MS = 15 * 60_000;
const REVISE_TIMEOUT_MS = 2 * 60_000;
/** How many times a revision starts again because the brief moved under it. */
const REVISE_TRIES = 3;

/** The directory under which every routine has one of its own. */
const homesIn = (dataDir: string): string => join(dataDir, "routines");

/** A routine's working directory: where its runs work, and what marks their sessions as its. */
function routineHome(dataDir: string, routineId: string): string {
  return join(homesIn(dataDir), routineId);
}

export interface RunnerOptions {
  store: RoutineStore;
  /** Where a sent report is posted. */
  timeline: Timeline;
  dataDir: string;
  now?: (() => number) | undefined;
  /** How long a run may take. */
  timeoutMs?: number | undefined;
  /** How long one revision of a brief may take. */
  reviseTimeoutMs?: number | undefined;
  /** Say that a routine's state moved. */
  changed: (routineId: string) => void;
  /** Say that a conversation's timeline moved. */
  posted: (conversationId: string) => void;
  warn: (message: string) => void;
}

/** A run that is going, as far as its tools are concerned. */
interface Active {
  finish?: Finish;
}

/** Why a session was stopped from outside, if it was. */
type Stopped = "closing" | "timeout" | undefined;

export class RoutineRunner {
  readonly #store: RoutineStore;
  readonly #timeline: Timeline;
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #reviseTimeoutMs: number;
  readonly #changed: RunnerOptions["changed"];
  readonly #posted: RunnerOptions["posted"];
  readonly #warn: (message: string) => void;

  #sessions: SessionsService | undefined;
  #closing = false;
  /** The runs that are going, by the session doing them. */
  readonly #active = new Map<string, Active>();
  /** What stops each session that is working for the runner (a run or a revision). */
  readonly #aborts = new Set<() => void>();
  readonly #runs = new Set<Promise<void>>();
  /** The revision pass of each routine that has one, so the passes of a routine are one after another. */
  readonly #revisions = new Map<string, Promise<void>>();

  constructor(options: RunnerOptions) {
    this.#store = options.store;
    this.#timeline = options.timeline;
    this.#dataDir = options.dataDir;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    this.#reviseTimeoutMs = options.reviseTimeoutMs ?? REVISE_TIMEOUT_MS;
    this.#changed = options.changed;
    this.#posted = options.posted;
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
   * The tools of a routine's session. The routine is found by the session's working directory; a
   * session anywhere else is not one of ours.
   */
  readonly sessionTools = (input: { meta: SessionMeta }): KernelTool[] => {
    const routineId = this.routineOf(input.meta);
    if (routineId === undefined) return [];
    const { id } = input.meta;
    return routineTools({
      store: this.#store,
      routineId,
      finish: (finish) => this.#finish(id, finish),
    });
  };

  /** The routine a session works for (a run or a revision of its brief), if it works for one. */
  readonly routineOf = (meta: Pick<SessionMeta, "cwd">): string | undefined => {
    if (dirname(meta.cwd) !== homesIn(this.#dataDir)) return undefined;
    const routineId = basename(meta.cwd);
    return this.#store.get(routineId) === undefined ? undefined : routineId;
  };

  #finish(sessionId: string, finish: Finish): string | undefined {
    const active = this.#active.get(sessionId);
    if (active === undefined)
      return "This is not a routine run that is under way, so there is nothing to finish.";
    if (active.finish !== undefined) return "This run has already finished.";
    active.finish = finish;
    return undefined;
  }

  /* ---------------------------------------------------------------- runs */

  /**
   * Start a run of a routine now. The run goes on after this returns. Nothing starts, and nothing
   * is returned, when the routine has a run going already or the runner is not taking runs.
   */
  start(routineId: string, startedBy: RunTrigger): RunRecord | undefined {
    const sessions = this.#sessions;
    const routine = this.#store.get(routineId);
    if (sessions === undefined || this.#closing || routine === undefined)
      return undefined;
    const run = this.#store.startRun(routineId, startedBy);
    if (run === undefined) return undefined;
    this.#changed(routineId);
    const task = this.#execute(sessions, routine, run).catch(
      (error: unknown) => {
        this.#warn(
          `[eta] routine ${routineId}: run ${run.id} could not be settled: ${messageOf(error)}`,
        );
      },
    );
    this.#runs.add(task);
    void task.finally(() => this.#runs.delete(task));
    return run;
  }

  async #execute(
    sessions: SessionsService,
    routine: RoutineRecord,
    run: RunRecord,
  ): Promise<void> {
    const active: Active = {};
    let outcome: RunOutcome;
    try {
      outcome = await this.#inSession(
        sessions,
        routine,
        `${routine.name} (routine run)`,
        this.#timeoutMs,
        async (managed, sessionId, stopped) => {
          this.#store.setRunSession(run.id, sessionId);
          this.#active.set(sessionId, active);
          this.#changed(routine.id);
          const brief = this.#store.brief(routine.id)!;
          const heard = listen(managed);
          try {
            managed.session.kernel.nextRun({
              role: "user",
              timestamp: this.#now(),
              content: [
                {
                  type: "text",
                  text: runPrompt({
                    name: routine.name,
                    schedule: routine.schedule,
                    timezone: routine.timezone,
                    now: this.#now(),
                    brief,
                    handoff: this.#store.handoff(routine.id),
                  }),
                },
              ],
            });
            const result = await managed.session.runner.run();
            return this.#outcomeOf(active, stopped(), result, heard.said());
          } finally {
            heard.stop();
            this.#active.delete(sessionId);
          }
        },
      );
    } catch (error) {
      // The session could not be made or run at all. A finish that was already recorded still
      // says how the run meant to end.
      outcome = active.finish
        ? finishOutcome(active.finish)
        : { status: "failed", error: messageOf(error) };
    }
    const ended = this.#store.finishRun(run.id, outcome);
    this.#changed(routine.id);
    if (ended?.status === "sent") this.#post(routine.id, ended);
  }

  /** How a run ended, from what its session did. */
  #outcomeOf(
    active: Active,
    stopped: Stopped,
    result: { status: "completed" | "failed" | "aborted"; error?: string },
    said: string,
  ): RunOutcome {
    // A finish is the run's own word and counts however the loop ended after it.
    if (active.finish !== undefined) return finishOutcome(active.finish);
    if (stopped === "closing") return { status: "failed", error: INTERRUPTED };
    if (stopped === "timeout")
      return {
        status: "failed",
        error: `The run took longer than ${describeLimit(this.#timeoutMs)} and was stopped.`,
      };
    if (result.status === "aborted")
      return { status: "failed", error: "The run was stopped." };
    if (result.status === "failed")
      return { status: "failed", error: result.error ?? "The run failed." };
    // Ended without `finish`: what it last said is the report.
    return said.trim() === ""
      ? {
          status: "failed",
          error:
            "The run ended without calling finish and without saying anything.",
        }
      : { status: "sent", report: said };
  }

  /** Put a sent report in the conversation the routine names, as a row of the system's. */
  #post(routineId: string, run: RunRecord): void {
    const routine = this.#store.get(routineId);
    if (routine?.conversationId == null || run.report === null) return;
    try {
      this.#timeline.system(
        routine.conversationId,
        `Routine "${routine.name}" sent a report.\n\n${run.report}`,
        {
          event: "routine_report",
          routineId,
          routineName: routine.name,
          runId: run.id,
          title: run.title,
        },
      );
      this.#posted(routine.conversationId);
    } catch (error) {
      // A conversation that is gone is the routine's loss to notice; the report is still its run's.
      this.#warn(
        `[eta] routine ${routineId} could not post its report: ${messageOf(error)}`,
      );
    }
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
    // There is no default model to run on: a routine without one fails here, saying what to do.
    if (routine.model === null)
      throw new Error(
        "This routine has no model. Choose one in the routine's settings.",
      );
    const cwd = routineHome(this.#dataDir, routine.id);
    await mkdir(cwd, { recursive: true });
    const sessionId = await sessions.create({
      cwd,
      title,
      model: routine.model,
    });
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

/** A `finish` as the outcome it asks for. */
function finishOutcome(finish: Finish): RunOutcome {
  const handoff = finish.handoff;
  return finish.report !== undefined && finish.report.trim() !== ""
    ? {
        status: "sent",
        report: finish.report,
        ...(finish.title === undefined ? {} : { title: finish.title }),
        ...(handoff === undefined ? {} : { handoff }),
      }
    : { status: "no_news", ...(handoff === undefined ? {} : { handoff }) };
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
