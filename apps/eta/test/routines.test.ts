/**
 * Routines through a real socket: the actions, a run's outcomes, its tools, the report in the
 * conversation, feedback and the revisions it leads to, and what a restart settles. The models are
 * scripted; the clock is moved by hand and the scheduler is told to look.
 */
import type {
  BriefView,
  ConversationSummary,
  FeedbackView,
  RoutineArgs,
  RoutineSections,
  RoutineSummary,
  RoutineUsage,
  RunListing,
  RunView,
} from "@eta/client-contracts";
import type { HostOptions } from "../src/host";
import type { Request } from "./support/models";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { databasePath } from "../src/db";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const at = (iso: string): number => Date.parse(iso);
const DAILY = { kind: "daily", time: "09:00" } as const;

const isRevision = (request: Request): boolean =>
  (request.transcript[0] ?? "").includes("You maintain the brief");

async function setup(
  respond: Parameters<typeof scriptedModels>[0],
  options: Partial<HostOptions> = {},
) {
  let clock = at("2026-10-18T08:00:00Z");
  const { models, requests } = scriptedModels(respond);
  const w = await world({
    models,
    routines: { now: () => clock, timer: false, ...options.routines },
    ...options,
  });
  w.client.subscribe("routines");
  const act = async <A extends keyof RoutineArgs, R = unknown>(
    action: A,
    args: RoutineArgs[A],
  ): Promise<R> => (await w.client.call("routines", action, args)) as R;
  const create = async (
    fields: Partial<RoutineArgs["create"]> = {},
  ): Promise<RoutineSummary> =>
    (
      await act<"create", { routine: RoutineSummary }>("create", {
        name: "Digest",
        brief: "Summarise the news.",
        schedule: DAILY,
        timezone: "UTC",
        ...fields,
      })
    ).routine;
  const watch = async (id: string) => {
    w.client.subscribe(`routines.${id}`);
    await until(() => w.client.section(`routines.${id}`, "info") !== undefined);
  };
  const sections = (id: string) => ({
    runs: () => w.client.section<RunView[]>(`routines.${id}`, "runs") ?? [],
    briefs: () =>
      w.client.section<BriefView[]>(`routines.${id}`, "briefs") ?? [],
    info: () =>
      w.client.section<RoutineSections["info"]>(`routines.${id}`, "info")!,
    handoff: () =>
      w.client.section<RoutineSections["handoff"]>(`routines.${id}`, "handoff"),
  });
  /** Run it now and wait for the run to end. */
  const runNow = async (id: string): Promise<RunView> => {
    await watch(id);
    const { run } = await act<"run", { run: RunListing }>("run", {
      routineId: id,
    });
    await until(
      () =>
        sections(id)
          .runs()
          .find((r) => r.id === run.id)?.status !== "running" &&
        sections(id)
          .runs()
          .some((r) => r.id === run.id),
    );
    return sections(id)
      .runs()
      .find((r) => r.id === run.id)!;
  };
  return {
    w,
    act,
    create,
    watch,
    sections,
    runNow,
    requests,
    tick: () => w.host.product.scheduler.tick(),
    setClock: (iso: string) => {
      clock = at(iso);
    },
  };
}

describe("the routines actions", () => {
  it("makes a routine with a brief and a next run, and publishes it", async () => {
    const t = await setup(() => say("x"));
    const routine = await t.create({ model: "fake:fake-model" });
    expect(routine).toMatchObject({
      name: "Digest",
      enabled: true,
      model: "fake:fake-model",
      conversationId: null,
      schedule: DAILY,
      timezone: "UTC",
      nextRunAt: at("2026-10-18T09:00:00Z"),
      revising: false,
      unseenReports: 0,
      runs: [],
    });
    await until(
      () =>
        (t.w.client.section<RoutineSummary[]>("routines", "list") ?? [])
          .length === 1,
    );
    await t.watch(routine.id);
    expect(t.sections(routine.id).briefs()).toMatchObject([
      { version: 1, text: "Summarise the news.", feedback: null },
    ]);
    expect(t.sections(routine.id).handoff()).toBeNull();
    const hello = await t.w.client.hello();
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(
        [
          "create",
          "update",
          "delete",
          "run",
          "seen",
          "feedback",
          "restoreBrief",
        ].map((a) => `routines.${a}`),
      ),
    );
    expect(Object.keys(hello.state)).toContain("routines");
  });

  it.each([
    ["no name", { name: " " }, /needs name|needs a name/],
    ["a bad zone", { timezone: "Mars/Base" }, /unknown time zone/],
    [
      "a schedule that never runs",
      { schedule: { kind: "cron", cron: "0 0 30 2 *" } },
      /never runs/,
    ],
    [
      "a schedule of six fields",
      { schedule: { kind: "cron", cron: "* * * * * *" } },
      /five fields/,
    ],
    [
      "a model without a provider",
      { model: "just-a-name" },
      /provider:modelId/,
    ],
    [
      "a conversation that is not there",
      { conversationId: "nope" },
      /no such conversation/,
    ],
  ])("refuses %s", async (_name, fields, message) => {
    const t = await setup(() => say("x"));
    await expect(t.create(fields as never)).rejects.toThrow(message);
    expect(t.w.client.section("routines", "list")).toEqual([]);
  });

  it("updates: renames, pauses, reschedules, and writes an edited brief as the next version", async () => {
    const t = await setup(() => say("x"));
    const routine = await t.create();
    await t.watch(routine.id);
    const { routine: paused } = await t.act<
      "update",
      { routine: RoutineSummary }
    >("update", {
      routineId: routine.id,
      name: "Renamed",
      enabled: false,
      brief: "New brief",
    });
    expect(paused).toMatchObject({
      name: "Renamed",
      enabled: false,
      nextRunAt: null,
    });
    await until(() => t.sections(routine.id).briefs().length === 2);
    expect(t.sections(routine.id).briefs()[0]).toMatchObject({
      version: 2,
      text: "New brief",
    });
    // The same brief again is not a new version.
    await t.act("update", {
      routineId: routine.id,
      brief: "New brief",
      enabled: true,
      schedule: { kind: "hourly", every: 2 },
    });
    expect(t.sections(routine.id).briefs()).toHaveLength(2);
    await until(() => t.sections(routine.id).info().schedule.kind === "hourly");
    expect(t.sections(routine.id).info().nextRunAt).toBe(
      at("2026-10-18T10:00:00Z"),
    );
    await expect(
      t.act("update", { routineId: routine.id, timezone: "Nowhere/Land" }),
    ).rejects.toThrow(/unknown time zone/);
    await expect(
      t.act("update", { routineId: "nope", name: "x" }),
    ).rejects.toThrow(/no such routine/);
  });

  it("deletes a routine that is idle, takes its target with it, and refuses one that is running", async () => {
    const hold = gate();
    const t = await setup(async () => {
      await hold.opened;
      return call("finish", { report: "# R" });
    });
    const routine = await t.create();
    await t.watch(routine.id);
    await t.act("run", { routineId: routine.id });
    await expect(t.act("delete", { routineId: routine.id })).rejects.toThrow(
      /is running/,
    );
    await expect(t.act("run", { routineId: routine.id })).rejects.toThrow(
      /already running/,
    );
    hold.open();
    await until(() => t.sections(routine.id).runs()[0]?.status === "sent");
    await t.act("delete", { routineId: routine.id });
    await until(
      () =>
        (t.w.client.section<RoutineSummary[]>("routines", "list") ?? [])
          .length === 0,
    );
    const ops = (await t.w.client.hello()).state;
    expect(Object.keys(ops)).not.toContain(`routines.${routine.id}`);
    await expect(t.act("delete", { routineId: routine.id })).rejects.toThrow(
      /no such routine/,
    );
  });
});

describe("a run", () => {
  it("is told what it needs, reports through finish, and leaves a handoff for the next run", async () => {
    const t = await setup((request) =>
      request.index === 0
        ? call("finish", {
            report: "# Big news\n\nIt happened.",
            handoff: "Remember the budget story.",
          })
        : call("finish", {}),
    );
    const routine = await t.create({
      name: "Morning digest",
      schedule: { kind: "weekly", days: [1, 3], time: "09:00" },
      timezone: "Asia/Shanghai",
    });
    const first = await t.runNow(routine.id);
    expect(first).toMatchObject({
      status: "sent",
      startedBy: "user",
      title: "Big news",
      report: "# Big news\n\nIt happened.",
      handoff: "Remember the budget story.",
      error: null,
    });
    expect(first.sessionId).toMatch(/^eta-/);
    // Told its name, schedule, zone, brief, the time, and that nothing came before it.
    const prompt = t.requests[0]!.transcript.join("\n");
    expect(prompt).toContain('routine "Morning digest"');
    expect(prompt).toContain("every Mon, Wed at 09:00");
    expect(prompt).toContain("Asia/Shanghai");
    expect(prompt).toContain("Summarise the news.");
    expect(prompt).toContain("Sunday 2026-10-18 16:00");
    expect(prompt).toContain("This is the first run");
    expect(t.requests[0]!.tools).toEqual(
      expect.arrayContaining(["list_runs", "get_run", "search_runs", "finish"]),
    );
    expect(t.sections(routine.id).handoff()).toMatchObject({
      text: "Remember the budget story.",
      runId: first.id,
    });

    // The next run is handed that, and a finish with no report is "no news".
    const second = await t.runNow(routine.id);
    expect(second).toMatchObject({
      status: "no_news",
      report: null,
      title: null,
    });
    expect(t.requests[1]!.transcript.join("\n")).toContain(
      "Remember the budget story.",
    );
    // It worked in a directory of the routine's own, and the session was put away.
    const sessions = await t.w.host.server.sessions.list();
    const meta = sessions.find((s) => s.ok && s.id === first.sessionId);
    expect(meta).toMatchObject({
      ok: true,
      meta: {
        cwd: expect.stringContaining(`routines/${routine.id}`),
        archived: true,
      },
    });
    expect(t.w.host.server.sessions.openSessions()).toEqual([]);
  });

  it("without finish, what it last said is the report; with nothing said it has failed", async () => {
    const t = await setup((request) =>
      request.index === 0 ? say("Plain words, no tool.") : say("   "),
    );
    const routine = await t.create();
    expect(await t.runNow(routine.id)).toMatchObject({
      status: "sent",
      report: "Plain words, no tool.",
      title: "Plain words, no tool.",
    });
    const silent = await t.runNow(routine.id);
    expect(silent.status).toBe("failed");
    expect(silent.error).toMatch(/without calling finish/);
  });

  it("a run the provider fails is a failure that says why", async () => {
    const { assistantMessage } = await import("@eta/core/testing");
    const t = await setup(() =>
      assistantMessage({
        stopReason: "error",
        errorMessage: "provider exploded",
      }),
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/provider exploded/);
    // The failure waits for the user, and the routine can run again.
    expect(t.sections(routine.id).info()).toMatchObject({
      unseenFailures: 1,
      unseenReports: 0,
    });
    expect(await t.runNow(routine.id)).toMatchObject({ status: "failed" });
  });

  it("a run that goes on too long is stopped and fails with the limit", async () => {
    const t = await setup(() => HANG, { routines: { timeoutMs: 150 } });
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toBe("The run took longer than 150 ms and was stopped.");
    expect(t.w.host.server.sessions.openSessions()).toEqual([]);
  });

  it("a routine runs once at a time, the clock's turn included", async () => {
    const hold = gate();
    const t = await setup(async () => {
      await hold.opened;
      return call("finish", { report: "# R" });
    });
    const routine = await t.create();
    await t.watch(routine.id);
    t.setClock("2026-10-18T08:59:59Z");
    t.tick();
    t.setClock("2026-10-18T09:00:00Z");
    expect(t.tick()).toEqual([routine.id]);
    await until(() => t.requests.length === 1);
    expect(t.sections(routine.id).runs()[0]).toMatchObject({
      status: "running",
      startedBy: "schedule",
    });
    // Its next time comes while it is still running: skipped.
    t.setClock("2026-10-19T09:00:00Z");
    t.tick();
    t.setClock("2026-10-19T09:00:00Z");
    expect(t.tick()).toEqual([]);
    await expect(t.act("run", { routineId: routine.id })).rejects.toThrow(
      /already running/,
    );
    expect(t.requests).toHaveLength(1);
    hold.open();
    await until(() => t.sections(routine.id).runs()[0]?.status === "sent");
    expect(t.sections(routine.id).runs()).toHaveLength(1);
  });

  it("the clock fires a run once at the time, not twice, and not while paused", async () => {
    const t = await setup(() => call("finish", { report: "# Tick" }));
    const routine = await t.create();
    await t.watch(routine.id);
    t.tick();
    t.setClock("2026-10-18T09:00:00Z");
    expect(t.tick()).toEqual([routine.id]);
    await until(() => t.sections(routine.id).runs()[0]?.status === "sent");
    expect(t.tick()).toEqual([]);
    await t.act("update", { routineId: routine.id, enabled: false });
    t.tick();
    t.setClock("2026-10-19T09:00:00Z");
    expect(t.tick()).toEqual([]);
    expect(t.sections(routine.id).runs()).toHaveLength(1);
  });

  it("looks at its own past through list_runs, get_run and search_runs, and only its own", async () => {
    const results: string[] = [];
    const t = await setup((request) => {
      // What the last tool answered, for the test to read afterwards.
      if (request.lastRole === "toolResult") results.push(request.last);
      switch (request.index) {
        case 0:
        case 1:
          return call("finish", {
            report: `# Report ${request.index + 1}\n\nunique-${request.index + 1}`,
            handoff: "h",
          });
        case 2:
          return call("finish", { report: "# Elsewhere\n\nunique-other" });
        case 3:
          return call("list_runs", {});
        case 4: {
          const id = /"id":"([^"]+)"[^}]*"title":"Report 1"/.exec(
            request.last,
          )![1]!;
          return call("get_run", { run: id });
        }
        case 5:
          return call("search_runs", { query: "unique-" });
        case 6:
          return call("get_run", {
            run: `${results[0]!.match(/"id":"([^"]+)"/)![1]!}-nope`,
          });
        default:
          return call("finish", {});
      }
    });
    const routine = await t.create();
    const other = await t.create({ name: "Other" });
    await t.runNow(routine.id);
    await t.runNow(routine.id);
    const foreign = await t.runNow(other.id);
    const third = await t.runNow(routine.id);
    expect(third.status).toBe("no_news");
    const [listed, one, found, refused] = results;
    // Newest first, its own two runs, not the one going now and not the other routine's.
    const parsed = JSON.parse(listed!) as { title: string }[];
    expect(parsed.map((r) => r.title)).toEqual(["Report 2", "Report 1"]);
    expect(one).toContain("unique-1");
    expect(one).toContain('"handoff":"h"');
    const hits = JSON.parse(found!) as { title: string }[];
    expect(hits.map((r) => r.title)).toEqual(["Report 2", "Report 1"]);
    expect(found).not.toContain(foreign.id);
    expect(refused).toContain("has no run");
  });

  it("posts a sent report into the conversation it names, and only a sent one", async () => {
    const t = await setup((request) => {
      if (request.index === 0)
        return call("finish", {
          report: "# Daily\n\nAll quiet.",
          title: "Quiet day",
        });
      if (request.index === 1) return call("finish", { handoff: "nothing" });
      return say("");
    });
    const agent = await t.w.agent("Ada");
    const project = await t.w.project({ stewardId: agent.id });
    const group: ConversationSummary = await t.w.group(
      project.id,
      [agent.id],
      "Room",
    );
    await t.w.watch(group.id);
    const routine = await t.create({ name: "Ops", conversationId: group.id });
    expect(routine.conversationId).toBe(group.id);

    const sent = await t.runNow(routine.id);
    await until(() => t.w.rows(group.id).length === 1);
    const row = t.w.rows(group.id)[0]!;
    expect(row).toMatchObject({
      kind: "system",
      author: "system",
      status: "done",
    });
    expect(row.text).toContain('Routine "Ops" sent a report.');
    expect(row.text).toContain("All quiet.");
    expect(row.data).toMatchObject({
      event: "routine_report",
      routineId: routine.id,
      runId: sent.id,
      title: "Quiet day",
    });

    await t.runNow(routine.id); // no news
    await t.runNow(routine.id); // failure
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.w.rows(group.id)).toHaveLength(1);
    // Unlinked, it posts nowhere.
    await t.act("update", { routineId: routine.id, conversationId: null });
    expect(t.sections(routine.id).info().conversationId).toBeNull();
  });
});

describe("what a restart settles", () => {
  it("fails a run a dead process left going, with a reason, and lets the routine run again", async () => {
    const dataDir = await tempDir();
    const first = await setup(() => call("finish", { report: "# Back" }), {
      dataDir,
    } as never);
    const routine = await first.create();
    await first.w.host.close();

    // A process that died mid-run leaves a running row behind.
    const db = new Database(databasePath(dataDir));
    db.query(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('ghost', ?, 'schedule', 'running', 1)",
    ).run(routine.id);
    db.close();

    const second = await setup(() => call("finish", { report: "# Back" }), {
      dataDir,
    } as never);
    await second.watch(routine.id);
    expect(second.sections(routine.id).runs()[0]).toMatchObject({
      id: "ghost",
      status: "failed",
      error: "The server restarted before this run finished.",
    });
    expect(second.sections(routine.id).info().unseenFailures).toBe(1);
    expect(await second.runNow(routine.id)).toMatchObject({ status: "sent" });
  });

  it("a host that closes under a run fails it as interrupted", async () => {
    const dataDir = await tempDir();
    const t = await setup(() => HANG, { dataDir } as never);
    const routine = await t.create();
    await t.watch(routine.id);
    await t.act("run", { routineId: routine.id });
    await until(() => t.requests.length === 1);
    await t.w.host.close();
    const db = new Database(databasePath(dataDir));
    const row = db
      .query<{ status: string; error: string }, []>(
        "SELECT status, error FROM routine_run",
      )
      .get()!;
    db.close();
    expect(row).toEqual({
      status: "failed",
      error: "The server restarted before this run finished.",
    });
  });
});

describe("seen", () => {
  it("clears what waits for the user, once", async () => {
    const t = await setup((request) =>
      request.index === 0
        ? call("finish", { report: "# R" })
        : call("finish", {}),
    );
    const routine = await t.create();
    await t.runNow(routine.id);
    await t.runNow(routine.id);
    expect(t.sections(routine.id).info()).toMatchObject({
      unseenReports: 1,
      unseenFailures: 0,
    });
    const { routine: after } = await t.act<"seen", { routine: RoutineSummary }>(
      "seen",
      { routineId: routine.id },
    );
    expect(after.unseenReports).toBe(0);
    await until(() =>
      t
        .sections(routine.id)
        .runs()
        .every((r) => r.seenAt !== null),
    );
  });
});

describe("feedback and the brief", () => {
  const feedbackOn = (
    t: Awaited<ReturnType<typeof setup>>,
    id: string,
    run: RunView,
    text = "Keep it shorter.",
  ) =>
    t.act<"feedback", { feedback: FeedbackView }>("feedback", {
      routineId: id,
      runId: run.id,
      text,
    });

  it("is made into the next version of the brief, which the next run follows", async () => {
    const t = await setup((request) =>
      isRevision(request)
        ? say("Summarise the news. Keep it short.")
        : call("finish", { report: "# R" }),
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    const { feedback } = await feedbackOn(t, routine.id, run);
    expect(feedback).toMatchObject({
      briefVersion: null,
      revisionFailed: false,
    });
    await until(() => t.sections(routine.id).briefs().length === 2);
    expect(t.sections(routine.id).briefs()[0]).toMatchObject({
      version: 2,
      text: "Summarise the news. Keep it short.",
      feedback: "Keep it shorter.",
    });
    await until(() => !t.sections(routine.id).info().revising);
    await until(
      () => t.sections(routine.id).runs()[0]?.feedback[0]?.briefVersion === 2,
    );
    // The reviser was shown the brief, the report and the feedback.
    const asked = t.requests.find(isRevision)!.transcript.join("\n");
    expect(asked).toContain("Summarise the news.");
    expect(asked).toContain("# R");
    expect(asked).toContain("Keep it shorter.");
    await t.runNow(routine.id);
    expect(t.requests.at(-1)!.transcript.join("\n")).toContain("(version 2)");
  });

  it("restarts from the newer text when the brief moved while the model was answering", async () => {
    let revisions = 0;
    const t: Awaited<ReturnType<typeof setup>> = await setup(
      async (request) => {
        if (!isRevision(request)) return call("finish", { report: "# R" });
        revisions += 1;
        if (revisions === 1) {
          // Someone edits the brief while this answer is being written.
          const id = t.w.client.section<RoutineSummary[]>(
            "routines",
            "list",
          )![0]!.id;
          await t.act("update", {
            routineId: id,
            brief: "A person rewrote it.",
          });
          return say("Revised from the old text.");
        }
        return say("A person rewrote it. And shorter.");
      },
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    await feedbackOn(t, routine.id, run);
    await until(() => t.sections(routine.id).briefs().length === 3);
    const briefs = t.sections(routine.id).briefs();
    expect(briefs.map((b) => b.text)).toEqual([
      "A person rewrote it. And shorter.",
      "A person rewrote it.",
      "Summarise the news.",
    ]);
    expect(briefs[0]!.feedback).toBe("Keep it shorter.");
    // The stale answer was thrown away; the second ask was made from the newer text.
    const asks = t.requests.filter(isRevision);
    expect(asks).toHaveLength(2);
    expect(asks[0]!.transcript.join("\n")).not.toContain(
      "A person rewrote it.",
    );
    expect(asks[1]!.transcript.join("\n")).toContain("A person rewrote it.");
  });

  it("gives up, on record, when the brief keeps moving or the model fails", async () => {
    let mode: "moving" | "failing" | "empty" = "moving";
    let edits = 0;
    const t: Awaited<ReturnType<typeof setup>> = await setup(
      async (request) => {
        if (!isRevision(request)) return call("finish", { report: "# R" });
        if (mode === "moving") {
          const id = t.w.client.section<RoutineSummary[]>(
            "routines",
            "list",
          )![0]!.id;
          await t.act("update", { routineId: id, brief: `edit ${++edits}` });
          return say("never lands");
        }
        if (mode === "empty") return say("  ");
        const { assistantMessage } = await import("@eta/core/testing");
        return assistantMessage({
          stopReason: "error",
          errorMessage: "no model",
        });
      },
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    await feedbackOn(t, routine.id, run, "one");
    await until(
      () =>
        t.sections(routine.id).runs()[0]?.feedback[0]?.revisionFailed === true,
    );
    expect(t.requests.filter(isRevision)).toHaveLength(3);
    expect(
      t
        .sections(routine.id)
        .briefs()
        .every((b) => b.feedback === null),
    ).toBe(true);
    await until(() => !t.sections(routine.id).info().revising);

    mode = "failing";
    await feedbackOn(t, routine.id, run, "two");
    await until(
      () =>
        t.sections(routine.id).runs()[0]?.feedback.at(-1)?.revisionFailed ===
        true,
    );
    mode = "empty";
    await feedbackOn(t, routine.id, run, "three");
    await until(
      () =>
        t.sections(routine.id).runs()[0]?.feedback.at(-1)?.revisionFailed ===
        true,
    );
    expect(t.sections(routine.id).info().revising).toBe(false);
  });

  it("is refused for a run still going, a run of another routine, or nothing", async () => {
    const hold = gate();
    const t = await setup(async (request) => {
      if (request.index === 0) await hold.opened;
      return call("finish", { report: "# R" });
    });
    const a = await t.create();
    const b = await t.create({ name: "B" });
    await t.watch(a.id);
    const { run } = await t.act<"run", { run: RunListing }>("run", {
      routineId: a.id,
    });
    await expect(
      t.act("feedback", { routineId: a.id, runId: run.id, text: "x" }),
    ).rejects.toThrow(/not finished/);
    hold.open();
    await until(() => t.sections(a.id).runs()[0]?.status === "sent");
    await expect(
      t.act("feedback", { routineId: b.id, runId: run.id, text: "x" }),
    ).rejects.toThrow(/no such run/);
    await expect(
      t.act("feedback", { routineId: a.id, runId: run.id, text: " " }),
    ).rejects.toThrow(/needs text/);
  });

  it("restoring an old version writes it as the newest, and the next run follows it", async () => {
    const t = await setup(() => call("finish", { report: "# R" }));
    const routine = await t.create();
    await t.watch(routine.id);
    await t.act("update", { routineId: routine.id, brief: "Second text" });
    await until(() => t.sections(routine.id).briefs().length === 2);
    const { brief } = await t.act<"restoreBrief", { brief: BriefView }>(
      "restoreBrief",
      { routineId: routine.id, version: 1 },
    );
    expect(brief).toMatchObject({
      version: 3,
      text: "Summarise the news.",
      feedback: null,
    });
    await until(() => t.sections(routine.id).briefs().length === 3);
    await t.runNow(routine.id);
    expect(t.requests[0]!.transcript.join("\n")).toContain("(version 3)");
    await expect(
      t.act("restoreBrief", { routineId: routine.id, version: 9 }),
    ).rejects.toThrow(/no such brief version/);
  });

  it("feedback a restart interrupted is picked up again when the host starts", async () => {
    const dataDir = await tempDir();
    const first = await setup(() => call("finish", { report: "# R" }), {
      dataDir,
    } as never);
    const routine = await first.create();
    const run = await first.runNow(routine.id);
    await first.w.host.close();
    const db = new Database(databasePath(dataDir));
    db.query(
      "INSERT INTO routine_feedback (id, run_id, text, created_at) VALUES ('fb', ?, 'Be brief.', 1)",
    ).run(run.id);
    db.close();

    const second = await setup(
      (request) =>
        isRevision(request) ? say("Summarise the news. Be brief.") : say("x"),
      { dataDir } as never,
    );
    await second.watch(routine.id);
    await until(() => second.sections(routine.id).briefs().length === 2);
    expect(second.sections(routine.id).briefs()[0]).toMatchObject({
      text: "Summarise the news. Be brief.",
      feedback: "Be brief.",
    });
  });
});

describe("what a routine's run costs", () => {
  it("is counted under the routine, not under an agent, and shows in the usage target", async () => {
    const t = await setup(() => call("finish", { report: "# News\n\nok" }));
    const routine = await t.create();
    await t.runNow(routine.id);
    const row = t.w.host.db
      .query<{ agent_id: string | null; routine_id: string | null }, []>(
        "SELECT agent_id, routine_id FROM usage",
      )
      .get();
    expect(row).toEqual({ agent_id: null, routine_id: routine.id });

    t.w.client.subscribe("usage");
    await until(() => t.w.client.section("usage", "routines") !== undefined);
    const usage = t.w.client.section<RoutineUsage[]>("usage", "routines")!;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      routineId: routine.id,
      windows: { "5h": { requests: 1 }, "30d": { requests: 1 } },
    });
    // Not among the agentless sessions.
    expect(t.w.client.section<unknown[]>("usage", "agents")).toEqual([]);
  });
});
