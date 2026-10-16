/**
 * The clock routines run on (REFACTOR.md §9, P3.3).
 *
 * AXP put the schedules in NATS: each routine's cron lived in the stream, and the broker fired it.
 * Here the scheduler is a timer in this process, which is the point of the single-process shape —
 * no broker, no stream, and the schedule is derived from the rows, so what runs is always what the
 * database says.
 *
 * **A missed firing is not caught up.** AXP's rule, kept: a run happens when its time comes and the
 * process is up; if the process was down, the time passed and that is that. A routine that fired
 * three times while nothing was listening should not then run three times — a report nobody asked
 * for, twice over.
 */
import type { RoutineRecord, RoutineStore } from "./store";
import { nextRun } from "./schedule";

export interface SchedulerOptions {
  routines: RoutineStore;
  /** Start a routine now, by id. What a firing does. */
  run: (routineId: string) => void;
  /** How often the clock looks. A minute is the resolution a cron expression has. */
  tickMs?: number | undefined;
  /** Called when a routine is due; the default runs it. */
  now?: (() => Date) | undefined;
  warn?: ((message: string) => void) | undefined;
}

interface Pending {
  routine: RoutineRecord;
  /** When it is due, in milliseconds. */
  at: number;
}

export class Scheduler {
  readonly #routines: RoutineStore;
  readonly #run: (routineId: string) => void;
  readonly #tickMs: number;
  readonly #now: () => Date;
  readonly #warn: (message: string) => void;
  readonly #pending = new Map<string, Pending>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: SchedulerOptions) {
    this.#routines = options.routines;
    this.#run = options.run;
    this.#tickMs = options.tickMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#warn = options.warn ?? (() => undefined);
  }

  /** Put every enabled routine on the clock. What a boot does, and what a change re-does. */
  sync(): void {
    const enabled = this.#routines.enabled();
    const seen = new Set<string>();
    for (const routine of enabled) {
      seen.add(routine.id);
      // A routine whose time has moved keeps the new one; one that was not on the clock gets it.
      const existing = this.#pending.get(routine.id);
      if (
        existing !== undefined &&
        existing.routine.updatedAt === routine.updatedAt
      )
        continue;
      this.schedule(routine);
    }
    for (const id of [...this.#pending.keys()]) {
      if (!seen.has(id)) this.#pending.delete(id);
    }
  }

  /** Put one routine on the clock, replacing whatever was there. */
  schedule(routine: RoutineRecord): void {
    if (!routine.enabled) {
      this.#pending.delete(routine.id);
      return;
    }
    const at = nextRun(routine.schedule, routine.timezone, this.#now());
    if (at === undefined) {
      // A schedule that never happens (February 30th): say so rather than keeping a timer that
      // will never fire.
      this.#warn(
        `[eta] routine ${routine.id} 的计划永远不会触发：${JSON.stringify(routine.schedule)}`,
      );
      this.#pending.delete(routine.id);
      return;
    }
    this.#pending.set(routine.id, { routine, at: at.getTime() });
  }

  /** What is on the clock, soonest first: what a page could show, and what a test asserts on. */
  upcoming(): { routineId: string; at: Date }[] {
    return [...this.#pending.values()]
      .map((pending) => ({
        routineId: pending.routine.id,
        at: new Date(pending.at),
      }))
      .sort((left, right) => left.at.getTime() - right.at.getTime());
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.sync();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Fire what is due, then re-arm.
   *
   * Re-arming from *now* rather than from the due time is what makes a missed firing missed: the
   * next occurrence is computed forward, so a gap does not produce a burst.
   */
  async tick(at: Date = this.#now()): Promise<string[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const fired: string[] = [];
    try {
      for (const [id, pending] of [...this.#pending]) {
        if (pending.at > at.getTime()) continue;
        // The routine may have been paused, edited or deleted since it was put on the clock.
        const current = this.#routines.get(id);
        if (current === undefined || !current.enabled) {
          this.#pending.delete(id);
          continue;
        }
        this.#run(id);
        fired.push(id);
        this.schedule(current);
      }
    } catch (error) {
      this.#warn(
        `[eta] the routine clock failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#ticking = false;
    }
    return fired;
  }
}
