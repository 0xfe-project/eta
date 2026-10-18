/**
 * The routines' clock with a clock the test moves: when it fires, that it fires once, and what it
 * does with the times that passed while nobody was looking (a restart, a long sleep).
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Scheduler } from "../src/routines/scheduler";
import { RoutineStore } from "../src/routines/store";

const at = (iso: string): number => Date.parse(iso);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const open: Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of open.splice(0)) db.close();
});

/**
 * A store, a clock to move, and a scheduler whose firing is a run started in the store, the way
 * the product wires it: so "one at a time" is the schema's, not the test's.
 */
function setup(
  start = "2026-10-18T08:00:00Z",
  options: { timer?: boolean; now?: () => number } = {},
) {
  const db = openDatabase(":memory:");
  open.push(db);
  applyMigrations(db, loadMigrations());
  let clock = at(start);
  const now = options.now ?? (() => clock);
  const store = new RoutineStore(db, now);
  const warnings: string[] = [];
  const started: string[] = [];
  const scheduler = new Scheduler({
    store,
    fire: (routineId) => {
      const run = store.startRun(routineId, "schedule");
      if (run !== undefined) started.push(routineId);
      return run !== undefined;
    },
    now,
    timer: options.timer ?? false,
    warn: (message) => warnings.push(message),
  });
  const routine = (
    schedule: RoutineSchedule = { kind: "daily", time: "09:00" },
    timezone = "UTC",
    name = "Digest",
  ) =>
    store.create({
      name,
      brief: "b",
      conversationId: null,
      model: null,
      schedule,
      timezone,
      enabled: true,
    });
  return {
    db,
    store,
    scheduler,
    routine,
    started,
    warnings,
    /** Move the clock to a moment, and let the scheduler look. */
    at(iso: string) {
      clock = at(iso);
      return scheduler.tick();
    },
    move(ms: number) {
      clock += ms;
      return scheduler.tick();
    },
    now,
  };
}

describe("firing on time", () => {
  it("starts a routine when its time comes, and not before", () => {
    const t = setup();
    const { id } = t.routine();
    t.scheduler.start();
    expect(t.at("2026-10-18T08:59:59.999Z")).toEqual([]);
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([id]);
    expect(t.started).toEqual([id]);
    expect(t.store.runningRun(id)!.startedBy).toBe("schedule");
  });

  it("does not fire the same time twice, however often it is asked", () => {
    const t = setup();
    const { id } = t.routine();
    t.scheduler.start();
    t.at("2026-10-18T09:00:00Z");
    // The run is over at once, so only the clock can be what keeps a second one from starting.
    t.store.finishRun(t.store.runningRun(id)!.id, { status: "no_news" });
    for (const offset of [0, 1, 1000, 30_000, 59_999]) {
      expect(
        t.at(new Date(at("2026-10-18T09:00:00Z") + offset).toISOString()),
      ).toEqual([]);
    }
    expect(t.started).toEqual([id]);
  });

  it("fires again at the next time: a day on", () => {
    const t = setup();
    const { id } = t.routine();
    t.scheduler.start();
    t.at("2026-10-18T09:00:00Z");
    t.store.finishRun(t.store.runningRun(id)!.id, { status: "no_news" });
    expect(t.at("2026-10-19T08:59:59Z")).toEqual([]);
    expect(t.at("2026-10-19T09:00:00Z")).toEqual([id]);
    expect(t.started).toEqual([id, id]);
  });

  it("reads the time in the routine's zone, daylight saving included", () => {
    const t = setup("2026-03-08T06:00:00Z");
    const shanghai = t.routine(
      { kind: "daily", time: "09:00" },
      "Asia/Shanghai",
      "SH",
    );
    // 02:30 in New York does not exist on 2026-03-08; the run is at 03:30 EDT, 07:30Z.
    const newYork = t.routine(
      { kind: "daily", time: "02:30" },
      "America/New_York",
      "NY",
    );
    t.scheduler.start();
    expect(t.at("2026-03-08T07:29:59Z")).toEqual([]);
    expect(t.at("2026-03-08T07:30:00Z")).toEqual([newYork.id]);
    // Shanghai's 09:00 is 01:00Z: a day later, since it had passed when the clock started.
    t.store.finishRun(t.store.runningRun(newYork.id)!.id, {
      status: "no_news",
    });
    expect(t.at("2026-03-09T00:59:59Z")).toEqual([]);
    expect(t.at("2026-03-09T01:00:00Z")).toEqual([shanghai.id]);
  });

  it("starts everything that is due together, each once", () => {
    const t = setup();
    const a = t.routine({ kind: "daily", time: "09:00" }, "UTC", "A");
    const b = t.routine({ kind: "cron", cron: "0 9 * * *" }, "UTC", "B");
    const later = t.routine({ kind: "daily", time: "10:00" }, "UTC", "Later");
    t.scheduler.start();
    expect(t.at("2026-10-18T09:00:00Z").sort()).toEqual([a.id, b.id].sort());
    expect(t.store.runningRun(later.id)).toBeUndefined();
  });

  it("a routine whose start throws is reported and does not hold up the others", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    let clock = at("2026-10-18T08:00:00Z");
    const store = new RoutineStore(db, () => clock);
    const make = (name: string) =>
      store.create({
        name,
        brief: "b",
        conversationId: null,
        model: null,
        schedule: { kind: "daily", time: "09:00" },
        timezone: "UTC",
        enabled: true,
      });
    const bad = make("bad");
    const good = make("good");
    const warnings: string[] = [];
    const fired: string[] = [];
    const scheduler = new Scheduler({
      store,
      fire: (id) => {
        if (id === bad.id) throw new Error("boom");
        fired.push(id);
        return true;
      },
      now: () => clock,
      timer: false,
      warn: (m) => warnings.push(m),
    });
    scheduler.start();
    clock = at("2026-10-18T09:00:00Z");
    expect(scheduler.tick()).toEqual([good.id]);
    expect(fired).toEqual([good.id]);
    expect(warnings.join()).toMatch(/boom/);
  });
});

describe("times that passed while nobody was looking", () => {
  it("after a restart the clock counts from now: what fell due while the process was down is not made up", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const hourly = t.routine({ kind: "hourly", every: 1 }, "UTC", "Hourly");
    const daily = t.routine({ kind: "daily", time: "09:00" }, "UTC", "Daily");
    t.scheduler.start();
    t.scheduler.stop();

    // The process is down for two days. A new one starts at noon on the 20th, mid-hour.
    const restarted = new Scheduler({
      store: t.store,
      fire: (id) => t.store.startRun(id, "schedule") !== undefined,
      now: () => at("2026-10-20T12:20:00Z"),
      timer: false,
    });
    restarted.start();
    expect(t.started).toEqual([]);
    expect(t.store.runs(hourly.id, 10)).toEqual([]);
    expect(t.store.runs(daily.id, 10)).toEqual([]);
    // The first look only counted. The times after it are the first to run.
    expect(restarted.nextDue()).toBe(at("2026-10-20T13:00:00Z"));
  });

  it("a restart a moment before a time does not skip it", () => {
    const t = setup("2026-10-18T08:59:00Z");
    const { id } = t.routine();
    t.scheduler.start();
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([id]);
  });

  it("asleep through a time and awake soon after: it runs, once", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const minutely = t.routine(
      { kind: "cron", cron: "* * * * *" },
      "UTC",
      "Minutely",
    );
    t.scheduler.start();
    // Four minutes pass without a look: four times fell due, one run starts.
    expect(t.at("2026-10-18T08:04:30Z")).toEqual([minutely.id]);
    expect(t.started).toEqual([minutely.id]);
    t.store.finishRun(t.store.runningRun(minutely.id)!.id, {
      status: "no_news",
    });
    // The next time is counted from the look, not from the one that was late.
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T08:05:00Z"));
    expect(t.at("2026-10-18T08:05:00Z")).toEqual([minutely.id]);
  });

  it("asleep far past a time: it has been missed, and the next one is on schedule", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const { id } = t.routine({ kind: "hourly", every: 1 }, "UTC");
    t.scheduler.start();
    // 09:00 fell due; the first look after it is at 13:20.
    expect(t.at("2026-10-18T13:20:00Z")).toEqual([]);
    expect(t.started).toEqual([]);
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T14:00:00Z"));
    expect(t.at("2026-10-18T14:00:00Z")).toEqual([id]);
  });
});

describe("one run at a time", () => {
  it("a time that comes while the routine is still running is skipped, not queued", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const { id } = t.routine({ kind: "hourly", every: 1 }, "UTC");
    t.scheduler.start();
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([id]);
    const first = t.store.runningRun(id)!;
    // Still running at 10:00 and 11:00: nothing starts, and nothing is waiting afterwards.
    expect(t.at("2026-10-18T10:00:00Z")).toEqual([]);
    expect(t.at("2026-10-18T11:00:00Z")).toEqual([]);
    expect(t.store.runs(id, 10)).toHaveLength(1);
    t.store.finishRun(first.id, { status: "no_news" });
    expect(t.at("2026-10-18T11:30:00Z")).toEqual([]);
    expect(t.at("2026-10-18T12:00:00Z")).toEqual([id]);
    expect(t.store.runs(id, 10)).toHaveLength(2);
  });
});

describe("following the rows", () => {
  it("a routine that is paused is not fired, and when resumed counts from then", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const { id } = t.routine();
    t.scheduler.start();
    t.store.update(id, { enabled: false });
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([]);
    expect(t.scheduler.nextDue()).toBeUndefined();
    // Resumed the next morning at 09:30: 09:00 that day is behind it, so the next is tomorrow's.
    t.at("2026-10-19T09:30:00Z");
    t.store.update(id, { enabled: true });
    expect(t.at("2026-10-19T09:30:01Z")).toEqual([]);
    expect(t.scheduler.nextDue()).toBe(at("2026-10-20T09:00:00Z"));
    expect(t.at("2026-10-20T09:00:00Z")).toEqual([id]);
  });

  it("a new schedule replaces the old one without anyone telling the clock", () => {
    const t = setup("2026-10-18T08:00:00Z");
    const { id } = t.routine({ kind: "daily", time: "09:00" });
    t.scheduler.start();
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T09:00:00Z"));
    t.store.update(id, { schedule: { kind: "daily", time: "10:30" } });
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([]);
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T10:30:00Z"));
    expect(t.at("2026-10-18T10:30:00Z")).toEqual([id]);
  });

  it("a new zone moves the time", () => {
    const t = setup("2026-10-18T00:00:00Z");
    const { id } = t.routine({ kind: "daily", time: "09:00" }, "UTC");
    t.scheduler.start();
    t.store.update(id, { timezone: "Asia/Shanghai" });
    expect(t.at("2026-10-18T00:00:01Z")).toEqual([]);
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T01:00:00Z"));
    expect(t.at("2026-10-18T01:00:00Z")).toEqual([id]);
  });

  it("a routine that is made after the clock started is on it from the next look, and one that is deleted is off", () => {
    const t = setup("2026-10-18T08:00:00Z");
    t.scheduler.start();
    expect(t.scheduler.nextDue()).toBeUndefined();
    const { id } = t.routine();
    // A look right after creating it is what the plugin does.
    t.scheduler.tick();
    expect(t.scheduler.nextDue()).toBe(at("2026-10-18T09:00:00Z"));
    t.store.remove(id);
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([]);
    expect(t.scheduler.nextDue()).toBeUndefined();
  });

  it("a routine created in the minute before its time is not run for a time that was already behind it", () => {
    const t = setup("2026-10-18T09:00:30Z");
    t.scheduler.start();
    t.routine({ kind: "daily", time: "09:00" });
    expect(t.scheduler.tick()).toEqual([]);
    expect(t.scheduler.nextDue()).toBe(at("2026-10-19T09:00:00Z"));
  });

  it("a zone the runtime does not know is reported once and does not stop the others", () => {
    const t = setup("2026-10-18T08:00:00Z");
    // A row that bypassed validation, as an older version of the zone database could leave.
    t.db
      .query("UPDATE routine SET timezone = 'Nowhere/Land' WHERE id = ?")
      .run(t.routine({ kind: "daily", time: "09:00" }, "UTC", "Odd").id);
    const fine = t.routine({ kind: "daily", time: "09:00" }, "UTC", "Fine");
    t.scheduler.start();
    expect(t.warnings).toHaveLength(1);
    expect(t.at("2026-10-18T09:00:00Z")).toEqual([fine.id]);
    expect(t.warnings).toHaveLength(1);
  });
});

describe("the timer", () => {
  it("fires on its own at the time, with the timers a test controls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-18T08:59:50Z"));
    const t = setup("2026-10-18T08:59:50Z", { timer: true, now: Date.now });
    const { id } = t.routine();
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(t.store.runs(id, 10)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.store.runs(id, 10)).toHaveLength(1);
    t.store.finishRun(t.store.runningRun(id)!.id, { status: "no_news" });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(t.store.runs(id, 10)).toHaveLength(1);
    t.scheduler.stop();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(t.store.runs(id, 10)).toHaveLength(1);
  });

  it("learns of a routine made while it sleeps, when it is told to look", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-18T08:59:45Z"));
    const t = setup("2026-10-18T08:59:45Z", { timer: true, now: Date.now });
    t.scheduler.start();
    // With nothing on the clock it sleeps as long as it ever does: a minute. A routine due in
    // fifteen seconds must not wait that out.
    const { id } = t.routine({ kind: "daily", time: "09:00" });
    t.scheduler.tick();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(t.store.runs(id, 10)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.store.runs(id, 10)).toHaveLength(1);
    t.scheduler.stop();
  });
});
