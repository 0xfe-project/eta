/**
 * The clock routines run on: a timer in this process, and no broker.
 *
 * Nothing about the schedule is stored beside the routine rows. Each look at the clock reads the
 * enabled routines, works out when each next falls due from its schedule and zone, and remembers
 * only that answer, keyed by what it was worked out from: a routine that was created, paused,
 * resumed or rescheduled has a different key (or none), so it is put on the clock again from the
 * present and nobody has to tell the clock a thing changed. A routine seen for the first time is
 * never fired by that look.
 *
 * **A missed time is not made up.** A run happens when its time comes and the process is up. If
 * the process was down, the first look after it starts counts from now, so a routine that fell due
 * three times while nothing was listening runs on its next time and not three times at once. A
 * process that was merely asleep and wakes soon after the time fires it, once; one that wakes
 * long after has missed it, like a restart would have. And a routine that is already running is
 * not started a second time: it skips that time.
 */
import type { RoutineRecord, RoutineStore } from "./store";
import { nextRunAfter } from "./schedule";

/** The longest the clock sleeps between looks, so a change of the system time is noticed. */
const MAX_SLEEP_MS = 60_000;

/** A time this much past, or less, is still worth a run; any later and it has been missed. */
const MAX_LATE_MS = 5 * 60_000;

export interface SchedulerOptions {
  store: RoutineStore;
  /** Start a run of a routine because its time came; true when one started. */
  fire: (routineId: string) => boolean;
  now?: () => number;
  /** Whether `start` sets a timer. A test that moves time by hand turns it off and calls `tick`. */
  timer?: boolean;
  warn?: (message: string) => void;
}

interface Armed {
  /** What `at` was worked out from: the schedule and the zone. */
  key: string;
  /** When it falls due, or Infinity when the schedule has no further time. */
  at: number;
}

export class Scheduler {
  readonly #store: RoutineStore;
  readonly #fire: SchedulerOptions["fire"];
  readonly #now: () => number;
  readonly #timed: boolean;
  readonly #warn: (message: string) => void;
  readonly #armed = new Map<string, Armed>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#fire = options.fire;
    this.#now = options.now ?? Date.now;
    this.#timed = options.timer ?? true;
    this.#warn = options.warn ?? (() => undefined);
  }

  /** Put the enabled routines on the clock, from now, and keep looking. */
  start(): void {
    this.#running = true;
    this.tick();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#armed.clear();
  }

  /**
   * Look at the clock: start what is due, and work out the rest from the rows as they are now.
   * Returns the routines it started. Cheap enough to call whenever a routine changes, which is
   * also how the timer learns of a time sooner than the one it is waiting for.
   */
  tick(): string[] {
    const now = this.#now();
    const fired: string[] = [];
    const live = new Set<string>();
    for (const routine of this.#store.enabled()) {
      live.add(routine.id);
      const key = JSON.stringify([routine.schedule, routine.timezone]);
      const armed = this.#armed.get(routine.id);
      if (armed?.key !== key) {
        this.#armed.set(routine.id, { key, at: this.#after(routine, now) });
        continue;
      }
      if (armed.at > now) continue;
      // Due. Whatever happens to this time, the next one is counted from now.
      this.#armed.set(routine.id, { key, at: this.#after(routine, now) });
      if (now - armed.at > MAX_LATE_MS) continue;
      try {
        if (this.#fire(routine.id)) fired.push(routine.id);
      } catch (error) {
        this.#warn(
          `[eta] routine ${routine.id} could not be started: ${String(error)}`,
        );
      }
    }
    for (const id of this.#armed.keys()) {
      if (!live.has(id)) this.#armed.delete(id);
    }
    this.#sleep(now);
    return fired;
  }

  /** When the next time falls due among the routines on the clock; undefined when none does. */
  nextDue(): number | undefined {
    const times = [...this.#armed.values()].map((armed) => armed.at);
    const soonest = Math.min(...times);
    return Number.isFinite(soonest) ? soonest : undefined;
  }

  #after(routine: RoutineRecord, now: number): number {
    try {
      return nextRunAfter(routine.schedule, routine.timezone, now) ?? Infinity;
    } catch (error) {
      // A row that cannot be scheduled (a zone the runtime lost): say so once, and leave it be.
      this.#warn(
        `[eta] routine ${routine.id} cannot be scheduled: ${String(error)}`,
      );
      return Infinity;
    }
  }

  #sleep(now: number): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#running || !this.#timed) return;
    const due = this.nextDue();
    const wait = Math.min(MAX_SLEEP_MS, Math.max(1, (due ?? Infinity) - now));
    this.#timer = setTimeout(() => {
      try {
        this.tick();
      } catch (error) {
        this.#warn(`[eta] the routine clock failed: ${String(error)}`);
        // Keep the clock going: one bad look must not stop every routine for good.
        this.#sleep(this.#now());
      }
    }, wait);
    this.#timer.unref();
  }
}
