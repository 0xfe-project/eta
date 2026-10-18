/**
 * The routines' rows over a real (in-memory) database with the shipped migrations: the rules that
 * live in the schema and the statements, with no clock, no session and no socket in the way.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversations/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { MachineStore } from "../src/machines/store";
import { ProjectStore } from "../src/projects/store";
import { RoutineStore, titleOf } from "../src/routines/store";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** A store whose clock is a counter, so times are distinct and in the order things happened. */
function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  applyMigrations(db, loadMigrations());
  let clock = 1_000;
  const store = new RoutineStore(db, () => clock++);
  const routine = (name = "Digest") =>
    store.create({
      name,
      brief: "Summarise the news.",
      conversationId: null,
      model: null,
      schedule: { kind: "daily", time: "07:30" },
      timezone: "UTC",
      enabled: true,
    });
  return { db, store, routine, tick: (by = 1) => (clock += by) };
}

describe("a routine and its brief", () => {
  it("is made with its first brief, and listed in the order they were made", () => {
    const { store, routine } = setup();
    const first = routine("First");
    const second = routine("Second");
    expect(store.list().map((r) => r.name)).toEqual(["First", "Second"]);
    expect(store.briefs(first.id)).toMatchObject([
      { version: 1, text: "Summarise the news.", feedbackId: null },
    ]);
    expect(first).toMatchObject({
      enabled: true,
      model: null,
      conversationId: null,
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(store.enabled().map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it("changes what was sent, clears with null, and leaves the rest", () => {
    const { store, routine } = setup();
    const made = routine();
    const paused = store.update(made.id, { enabled: false, model: "a:b" })!;
    expect(paused).toMatchObject({
      enabled: false,
      model: "a:b",
      name: "Digest",
    });
    expect(store.enabled()).toEqual([]);
    expect(store.update(made.id, { model: null })!.model).toBeNull();
    expect(store.update("missing", { name: "x" })).toBeUndefined();
  });

  it("an edit is the next version, unless it says what is already in force", () => {
    const { store, routine } = setup();
    const { id } = routine();
    expect(store.editBrief(id, "Summarise the news.")).toBeUndefined();
    const v2 = store.editBrief(id, "Summarise the sport.")!;
    expect(v2.version).toBe(2);
    expect(store.brief(id)!.text).toBe("Summarise the sport.");
    expect(store.briefs(id).map((b) => b.version)).toEqual([2, 1]);
  });

  it("restoring writes the old text as the newest version and keeps the history", () => {
    const { store, routine } = setup();
    const { id } = routine();
    store.editBrief(id, "Second text");
    const restored = store.restoreBrief(id, 1)!;
    expect(restored).toMatchObject({
      version: 3,
      text: "Summarise the news.",
      feedbackId: null,
    });
    expect(store.briefs(id).map((b) => b.text)).toEqual([
      "Summarise the news.",
      "Second text",
      "Summarise the news.",
    ]);
    expect(store.restoreBrief(id, 9)).toBeUndefined();
  });

  it("a conversation that goes takes the link with it and leaves the routine", () => {
    const { db, store } = setup();
    const machine = new MachineStore(db).ensurePrimary({
      name: "box",
      home: "/h",
      os: "linux",
    });
    const project = new ProjectStore(db).create({
      machineId: machine.id,
      path: "/work",
      name: "w",
    });
    const conversation = new ConversationStore(db).create({
      projectId: project.id,
      kind: "group",
      name: "room",
      agentIds: [],
    });
    const linked = store.create({
      name: "Linked",
      brief: "b",
      conversationId: conversation.id,
      model: null,
      schedule: { kind: "daily", time: "07:30" },
      timezone: "UTC",
      enabled: true,
    });
    db.query("DELETE FROM conversation WHERE id = ?").run(conversation.id);
    expect(store.get(linked.id)!.conversationId).toBeNull();
  });

  it("removing it takes its briefs, runs and feedback", () => {
    const { db, store, routine } = setup();
    const { id } = routine();
    const run = store.startRun(id, "user")!;
    store.finishRun(run.id, { status: "sent", report: "# R" });
    store.addFeedback(run.id, "shorter");
    expect(store.remove(id)).toBe(true);
    for (const table of ["routine_brief", "routine_run", "routine_feedback"]) {
      expect(
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!
          .n,
      ).toBe(0);
    }
    expect(store.remove(id)).toBe(false);
  });
});

describe("runs", () => {
  it("a routine runs once at a time, and the schema is what says so", () => {
    const { db, store, routine } = setup();
    const { id } = routine();
    const first = store.startRun(id, "schedule")!;
    expect(first).toMatchObject({ status: "running", startedBy: "schedule" });
    expect(store.startRun(id, "user")).toBeUndefined();
    // Not just the method: a second running row is refused by the table.
    expect(() =>
      db
        .query(
          "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('x', ?, 'user', 'running', 1)",
        )
        .run(id),
    ).toThrow(/UNIQUE/);
    // Another routine is unaffected, and so is the same one once the run has ended.
    const other = routine("Other");
    expect(store.startRun(other.id, "user")).toBeDefined();
    store.finishRun(first.id, { status: "no_news" });
    expect(store.startRun(id, "user")).toBeDefined();
  });

  it("ends as sent, no_news or failed, and only the first ending counts", () => {
    const { store, routine } = setup();
    const { id } = routine();

    const sent = store.startRun(id, "user")!;
    const ended = store.finishRun(sent.id, {
      status: "sent",
      report: "  # Big day\n\nBody  ",
      handoff: " Remember the budget. ",
    })!;
    expect(ended).toMatchObject({
      status: "sent",
      report: "# Big day\n\nBody",
      title: "Big day",
      handoff: "Remember the budget.",
      error: null,
    });
    expect(ended.finishedAt).toBeGreaterThan(ended.startedAt);
    // A timeout arriving after the run's own ending changes nothing.
    expect(
      store.finishRun(sent.id, { status: "failed", error: "late" }),
    ).toBeUndefined();
    expect(store.run(sent.id)!.status).toBe("sent");

    const quiet = store.startRun(id, "user")!;
    expect(store.finishRun(quiet.id, { status: "no_news" })).toMatchObject({
      status: "no_news",
      report: null,
      title: null,
      handoff: null,
    });

    const broke = store.startRun(id, "user")!;
    expect(
      store.finishRun(broke.id, {
        status: "failed",
        error: "model_unavailable",
      }),
    ).toMatchObject({
      status: "failed",
      error: "model_unavailable",
      report: null,
    });
  });

  it("a report of nothing but space is no report; a title can be given, or is the first heading or line", () => {
    const { store, routine } = setup();
    const { id } = routine();
    const blank = store.startRun(id, "user")!;
    expect(
      store.finishRun(blank.id, { status: "sent", report: "  \n " }),
    ).toMatchObject({ status: "no_news", report: null });
    const titled = store.startRun(id, "user")!;
    expect(
      store.finishRun(titled.id, {
        status: "sent",
        report: "# From the heading",
        title: "Given title",
      })!.title,
    ).toBe("Given title");
    expect(titleOf("\n\n## Second level  \ntext")).toBe("Second level");
    expect(titleOf("No heading, just words\nmore")).toBe(
      "No heading, just words",
    );
    expect(titleOf("   ")).toBeNull();
    expect(titleOf(`### ${"x".repeat(300)}`)).toHaveLength(200);
  });

  it("lists newest first, and remembers the session that did the work", () => {
    const { store, routine, tick } = setup();
    const { id } = routine();
    const one = store.startRun(id, "user")!;
    store.finishRun(one.id, { status: "no_news" });
    tick();
    const two = store.startRun(id, "schedule")!;
    store.setRunSession(two.id, "eta-abc");
    expect(store.runs(id, 10).map((r) => r.id)).toEqual([two.id, one.id]);
    expect(store.runs(id, 1).map((r) => r.id)).toEqual([two.id]);
    expect(store.runningBySession("eta-abc")!.id).toBe(two.id);
    store.finishRun(two.id, { status: "no_news" });
    expect(store.runningBySession("eta-abc")).toBeUndefined();
  });

  it("the handoff is the newest one anybody wrote, and a run without one leaves it standing", () => {
    const { store, routine, tick } = setup();
    const { id } = routine();
    expect(store.handoff(id)).toBeUndefined();
    const one = store.startRun(id, "user")!;
    store.finishRun(one.id, { status: "no_news", handoff: "first note" });
    tick();
    const two = store.startRun(id, "user")!;
    store.finishRun(two.id, {
      status: "sent",
      report: "# R",
      handoff: "second note",
    });
    tick();
    const three = store.startRun(id, "user")!;
    store.finishRun(three.id, { status: "failed", error: "nope" });
    tick();
    const four = store.startRun(id, "user")!;
    store.finishRun(four.id, { status: "no_news" });
    expect(store.handoff(id)).toMatchObject({
      text: "second note",
      runId: two.id,
    });
  });

  it("settles what a dead process left running, and only that", () => {
    const { store, routine } = setup();
    const a = routine("A");
    const b = routine("B");
    const c = routine("C");
    const running = store.startRun(a.id, "schedule")!;
    const done = store.startRun(b.id, "user")!;
    store.finishRun(done.id, { status: "sent", report: "# Done" });
    store.startRun(c.id, "user");

    expect(store.recover("restarted").sort()).toEqual([a.id, c.id].sort());
    expect(store.run(running.id)).toMatchObject({
      status: "failed",
      error: "restarted",
    });
    expect(store.run(running.id)!.finishedAt).not.toBeNull();
    expect(store.run(done.id)!.status).toBe("sent");
    // Nothing is running, so nothing blocks the next run, and a second recovery has nothing to do.
    expect(store.recover("again")).toEqual([]);
    expect(store.startRun(a.id, "schedule")).toBeDefined();
  });

  it("seen: marks finished runs only, once, and the counts follow", () => {
    const { store, routine, tick } = setup();
    const { id } = routine();
    const sent = store.startRun(id, "user")!;
    store.finishRun(sent.id, { status: "sent", report: "# R" });
    tick();
    const quiet = store.startRun(id, "user")!;
    store.finishRun(quiet.id, { status: "no_news" });
    tick();
    const failed = store.startRun(id, "user")!;
    store.finishRun(failed.id, { status: "failed", error: "x" });
    tick();
    const going = store.startRun(id, "user")!;

    expect(store.unseen(id)).toEqual({ reports: 1, failures: 1 });
    expect(store.markSeen(id)).toBe(3);
    expect(store.unseen(id)).toEqual({ reports: 0, failures: 0 });
    expect(store.markSeen(id)).toBe(0);
    // The run still going was not looked at, and when it ends it waits like any other.
    expect(store.run(going.id)!.seenAt).toBeNull();
    store.finishRun(going.id, { status: "sent", report: "# Later" });
    expect(store.unseen(id)).toEqual({ reports: 1, failures: 0 });
  });

  it("searches reports, handoffs, titles and feedback, literally, among finished runs", () => {
    const { store, routine, tick } = setup();
    const { id } = routine();
    const other = routine("Other");
    const a = store.startRun(id, "user")!;
    store.finishRun(a.id, { status: "sent", report: "# Rates\n\nup 5% today" });
    tick();
    const b = store.startRun(id, "user")!;
    store.finishRun(b.id, { status: "no_news", handoff: "watch the_budget" });
    tick();
    const c = store.startRun(id, "user")!;
    store.finishRun(c.id, { status: "sent", report: "# Weather\n\nrain" });
    store.addFeedback(c.id, "too much about umbrellas");
    tick();
    store.startRun(id, "user"); // still going: never found
    const elsewhere = store.startRun(other.id, "user")!;
    store.finishRun(elsewhere.id, {
      status: "sent",
      report: "# Rates elsewhere",
    });

    const ids = (text: string) =>
      store.searchRuns(id, text, 10).map((run) => run.id);
    expect(ids("rates")).toEqual([a.id]);
    expect(ids("umbrellas")).toEqual([c.id]);
    expect(ids("5%")).toEqual([a.id]);
    // `_` and `%` are not wildcards.
    expect(ids("the_budget")).toEqual([b.id]);
    expect(ids("the?budget")).toEqual([]);
    expect(ids("%")).toEqual([a.id]);
    expect(store.searchRuns(id, "e", 2)).toHaveLength(2);
  });
});

describe("feedback and the revisions it leads to", () => {
  it("is pending until a brief version names it or its revision is recorded as failed", () => {
    const { store, routine } = setup();
    const { id } = routine();
    const run = store.startRun(id, "user")!;
    store.finishRun(run.id, { status: "sent", report: "# R" });
    const one = store.addFeedback(run.id, "shorter please");
    const two = store.addFeedback(run.id, "and in French");
    expect(one).toMatchObject({
      routineId: id,
      runId: run.id,
      briefVersion: null,
      revisionFailed: false,
    });
    expect(store.pendingFeedback(id).map((f) => f.id)).toEqual([
      one.id,
      two.id,
    ]);
    expect(store.pendingFeedback().map((f) => f.id)).toEqual([one.id, two.id]);

    const revised = store.reviseBrief({
      routineId: id,
      feedbackId: one.id,
      text: "Summarise the news, briefly.",
      basedOn: 1,
    })!;
    expect(revised).toMatchObject({ version: 2, feedbackId: one.id });
    expect(store.feedback(one.id)!.briefVersion).toBe(2);
    store.failRevision(two.id);
    expect(store.feedback(two.id)).toMatchObject({
      revisionFailed: true,
      briefVersion: null,
    });
    expect(store.pendingFeedback(id)).toEqual([]);
    expect(store.feedbackOn(run.id).map((f) => f.text)).toEqual([
      "shorter please",
      "and in French",
    ]);
  });

  it("a revision made from a brief that has since moved is refused, whoever moved it", () => {
    const { store, routine } = setup();
    const { id } = routine();
    const run = store.startRun(id, "user")!;
    store.finishRun(run.id, { status: "sent", report: "# R" });
    const feedback = store.addFeedback(run.id, "shorter");
    store.editBrief(id, "A person rewrote it.");
    expect(
      store.reviseBrief({
        routineId: id,
        feedbackId: feedback.id,
        text: "stale",
        basedOn: 1,
      }),
    ).toBeUndefined();
    expect(store.brief(id)!.text).toBe("A person rewrote it.");
    // From the newer version it goes through.
    expect(
      store.reviseBrief({
        routineId: id,
        feedbackId: feedback.id,
        text: "fresh",
        basedOn: 2,
      }),
    ).toMatchObject({ version: 3 });
  });

  it("one piece of feedback leads to one version, even if two passes race", () => {
    const { store, routine } = setup();
    const { id } = routine();
    const run = store.startRun(id, "user")!;
    store.finishRun(run.id, { status: "sent", report: "# R" });
    const feedback = store.addFeedback(run.id, "x");
    store.reviseBrief({
      routineId: id,
      feedbackId: feedback.id,
      text: "a",
      basedOn: 1,
    });
    expect(() =>
      store.reviseBrief({
        routineId: id,
        feedbackId: feedback.id,
        text: "b",
        basedOn: 2,
      }),
    ).toThrow(/UNIQUE/);
    expect(store.briefs(id)).toHaveLength(2);
  });
});
