/**
 * Routines through a real socket, run by Captain: the actions, a run as a new Captain session, its
 * two ways of ending (a report or no news for the user, a handoff for the next run) and the wall
 * between them, what happens while Captain is off, feedback and the revisions it leads to, what a
 * restart settles and what a run costs. The models are scripted; the clock is moved by hand and the
 * scheduler is told to look.
 */
import type {
  BriefView,
  CaptainOperationView,
  CaptainRoutineProposal,
  FeedbackView,
  RoutineArgs,
  RoutineSections,
  RoutinesStatus,
  RoutineSummary,
  RoutineUsage,
  RunListing,
  RunView,
} from "@eta/client-contracts";
import type { HostOptions } from "../src/host";
import type { Answer, Request } from "./support/models";
import { captainProposalOf } from "@eta/client-contracts";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { databasePath } from "../src/db";
import { PRIVATE_CLOSE, PRIVATE_OPEN } from "../src/routines/prompts";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const at = (iso: string): number => Date.parse(iso);
const DAILY = { kind: "daily", time: "09:00" } as const;

/** A request of a routine's run: its first message is the run prompt. */
const isRun = (request: Request): boolean =>
  (request.transcript[0] ?? "").includes("<routine-run>");
const isRevision = (request: Request): boolean =>
  (request.transcript[0] ?? "").includes("You maintain the brief");
/** How far into its session a request is: the answers it already gave. */
const step = (request: Request): number =>
  request.transcript.filter((line) => line.startsWith("assistant:")).length;

/**
 * Answers for routine runs, one script per run in the order the runs start: the n-th answer of a
 * run's session is its script's n-th entry, and "Done." after the script runs out. Anything that is
 * not a run (a revision, a memory pass) is answered by `other`.
 */
function runs(
  scripts:
    | readonly (readonly Answer[])[]
    | ((run: number) => readonly Answer[]),
  other: (request: Request) => Answer | Promise<Answer> = () => say(""),
) {
  let started = -1;
  return (request: Request): Answer | Promise<Answer> => {
    if (!isRun(request)) return other(request);
    if (step(request) === 0) started += 1;
    const script =
      typeof scripts === "function" ? scripts(started) : scripts[started];
    return script?.[step(request)] ?? say("Done.");
  };
}

const report = (title: string, body: string) => call("report", { title, body });
const handoff = (notes: string) => call("handoff", { notes });

async function setup(
  respond: Parameters<typeof scriptedModels>[0],
  options: Partial<HostOptions> = {},
) {
  let clock = at("2026-10-18T08:00:00Z");
  const { models, requests } = scriptedModels(respond);
  const w = await world({
    models,
    tasks: { runs: false },
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
  });
  /** Wait for a run to end, and return it as the page shows it. */
  const ended = async (id: string, runId: string): Promise<RunView> => {
    await until(() => {
      const run = sections(id)
        .runs()
        .find((r) => r.id === runId);
      return run !== undefined && run.status !== "running";
    });
    return sections(id)
      .runs()
      .find((r) => r.id === runId)!;
  };
  /** Run it now and wait for the run to end. */
  const runNow = async (id: string): Promise<RunView> => {
    await watch(id);
    const { run } = await act<"run", { run: RunListing }>("run", {
      routineId: id,
    });
    return await ended(id, run.id);
  };
  const captain = w.host.product.captain;
  const { conversationId: direct } = await captain.direct();
  await w.watch(direct);
  return {
    w,
    act,
    create,
    watch,
    sections,
    ended,
    runNow,
    requests,
    captain,
    captainId: captain.identity()!.agentId,
    direct,
    status: () => w.client.section<RoutinesStatus>("routines", "status"),
    tick: () => w.host.product.scheduler.tick(),
    setClock: (iso: string) => {
      clock = at(iso);
    },
  };
}

describe("the routines actions", () => {
  it("makes a routine of a name, a brief and a schedule, with no agent and no model", async () => {
    const t = await setup(runs([]));
    const routine = await t.create();
    expect(routine).toMatchObject({
      name: "Digest",
      enabled: true,
      schedule: DAILY,
      timezone: "UTC",
      nextRunAt: at("2026-10-18T09:00:00Z"),
      revising: false,
      unseenReports: 0,
      runs: [],
    });
    expect(routine).not.toHaveProperty("model");
    expect(routine).not.toHaveProperty("conversationId");
    await until(
      () =>
        (t.w.client.section<RoutineSummary[]>("routines", "list") ?? [])
          .length === 1,
    );
    await t.watch(routine.id);
    expect(t.sections(routine.id).briefs()).toMatchObject([
      { version: 1, text: "Summarise the news.", feedback: null },
    ]);
    // The routine's target has no handoff section, and the list says Captain is on.
    expect(
      t.w.client.section(`routines.${routine.id}`, "handoff"),
    ).toBeUndefined();
    await until(() => t.status() !== undefined);
    expect(t.status()).toEqual({ captainOn: true, reason: null });
  });

  it.each([
    ["no name", { name: " " }, /needs (a )?name/],
    ["no brief", { brief: " " }, /needs (a )?brief/],
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
  ])("refuses %s", async (_name, fields, message) => {
    const t = await setup(runs([]));
    await expect(t.create(fields as never)).rejects.toThrow(message);
    expect(t.w.client.section("routines", "list")).toEqual([]);
  });

  it("updates: renames, pauses, reschedules, and writes an edited brief as the next version", async () => {
    const t = await setup(runs([]));
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
    await t.act("update", {
      routineId: routine.id,
      brief: "New brief",
      enabled: true,
      schedule: { kind: "hourly", every: 2 },
    });
    expect(t.sections(routine.id).briefs()).toHaveLength(2);
    await until(() => t.sections(routine.id).info().schedule.kind === "hourly");
    await expect(
      t.act("update", { routineId: routine.id, timezone: "Nowhere/Land" }),
    ).rejects.toThrow(/unknown time zone/);
    await expect(
      t.act("update", { routineId: "nope", name: "x" }),
    ).rejects.toThrow(/no such routine/);
  });

  it("deletes a routine that is idle, and refuses one that is running", async () => {
    const hold = gate();
    const t = await setup(
      runs(() => [
        hold.opened.then(() => report("R", "body")) as unknown as Answer,
      ]),
    );
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
    expect(Object.keys((await t.w.client.hello()).state)).not.toContain(
      `routines.${routine.id}`,
    );
  });
});

describe("a run is Captain's", () => {
  it("is a new Captain session with Captain's tools and the routine's, told the brief and the time", async () => {
    const t = await setup(runs([[report("Big news", "It happened.")]]));
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
      report: "It happened.",
      error: null,
    });
    const asked = t.requests.find(isRun)!;
    // Captain, in a session of its own for this routine.
    expect(asked.system).toContain("El Capitan");
    expect(asked.system).toContain("running one of the user's routines");
    expect(asked.tools).toEqual(
      expect.arrayContaining([
        "report",
        "no_news",
        "handoff",
        "list_runs",
        "get_run",
        "search_runs",
        "assign_in_group",
        "dispatch_task",
        "post_in_group",
        "captain_list_tasks",
        "list_routines",
      ]),
    );
    expect(asked.tools).not.toContain("finish");
    const prompt = asked.transcript[0]!;
    expect(prompt).toContain('routine "Morning digest"');
    expect(prompt).toContain("every Mon, Wed at 09:00");
    expect(prompt).toContain("Asia/Shanghai");
    expect(prompt).toContain("Summarise the news.");
    expect(prompt).toContain("Sunday 2026-10-18 16:00");
    expect(prompt).toContain("This routine has not run before.");

    // The session is Captain's, held in the run's key, and put away afterwards.
    const sessions = await t.w.host.server.sessions.list();
    const meta = sessions.find((s) => s.ok && s.id === first.sessionId);
    expect(meta).toMatchObject({
      ok: true,
      meta: {
        agentId: t.captainId,
        conversationId: `routine:${first.id}`,
        cwd: expect.stringMatching(new RegExp(`routines[\\\\/]${routine.id}`)),
        archived: true,
      },
    });
    // A second run is a second session.
    const second = await t.runNow(routine.id);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("announces a report in Captain's chat with its title and a link, and nothing else", async () => {
    const t = await setup(
      runs([[report("Quiet day", "All quiet."), handoff("PRIVATE-NOTE-1")]]),
    );
    const routine = await t.create({ name: "Ops" });
    const run = await t.runNow(routine.id);
    await until(() =>
      t.w.rows(t.direct).some((row) => row.data?.event === "routine_report"),
    );
    const row = t.w
      .rows(t.direct)
      .find((r) => r.data?.event === "routine_report")!;
    expect(row).toMatchObject({ kind: "system", author: "system" });
    expect(row.text).toBe('Routine "Ops" reported: Quiet day');
    expect(row.data).toMatchObject({
      routineId: routine.id,
      runId: run.id,
      title: "Quiet day",
    });
    expect(JSON.stringify(row)).not.toContain("PRIVATE-NOTE-1");
  });

  it("no_news tells the user there was nothing, and nobody is announced to", async () => {
    const t = await setup(runs([[call("no_news", {})]]));
    const routine = await t.create();
    expect(await t.runNow(routine.id)).toMatchObject({
      status: "no_news",
      report: null,
      title: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      t.w.rows(t.direct).some((row) => row.data?.event === "routine_report"),
    ).toBe(false);
  });

  it("a run reports once: a second report or a no_news after it is refused", async () => {
    const results: string[] = [];
    const t = await setup(
      runs(
        [
          [
            report("One", "first"),
            report("Two", "second"),
            call("no_news", {}),
          ],
        ],
        () => say(""),
      ),
    );
    const routine = await t.create();
    const unwatched = t.requests.length;
    const run = await t.runNow(routine.id);
    for (const request of t.requests.slice(unwatched).filter(isRun))
      if (request.lastRole === "toolResult") results.push(request.last);
    expect(run).toMatchObject({
      status: "sent",
      title: "One",
      report: "first",
    });
    expect(results[1]).toMatch(/already sent its report/);
    expect(results[2]).toMatch(/already sent its report/);
  });

  it("is asked once more when it stops without a word for the user, and fails if it still says nothing", async () => {
    const t = await setup(
      runs([
        // Talks, then reports when reminded.
        [say("I looked around."), report("Late", "Found it.")],
        // Talks twice and never reports: a failure, and what it said is not taken for a report.
        [
          handoff("KEEP-THIS"),
          say("Next time I will check the logs."),
          say("Still nothing."),
        ],
      ]),
    );
    const routine = await t.create();
    const nudged = await t.runNow(routine.id);
    expect(nudged).toMatchObject({ status: "sent", title: "Late" });
    const reminders = t.requests.filter(
      (r) =>
        isRun(r) && r.last.includes("has not called `report` or `no_news`"),
    );
    expect(reminders).toHaveLength(1);

    const silent = await t.runNow(routine.id);
    expect(silent).toMatchObject({
      status: "failed",
      report: null,
      error: "The run ended without calling report or no_news.",
    });
    // Its note still reaches the next run.
    expect(t.w.host.product.routines.store.handoff(routine.id)?.text).toBe(
      "KEEP-THIS",
    );
  });

  it("a run the provider fails is a failure that says why", async () => {
    const { assistantMessage } = await import("@eta/core/testing");
    const t = await setup(
      runs(() => [
        assistantMessage({
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
      ]),
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/provider exploded/);
    expect(t.sections(routine.id).info()).toMatchObject({
      unseenFailures: 1,
      unseenReports: 0,
    });
  });

  it("a run that goes on too long is stopped and fails with the limit", async () => {
    const t = await setup((request) => (isRun(request) ? HANG : say("")), {
      routines: { timeoutMs: 150 },
    });
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toBe("The run took longer than 150 ms and was stopped.");
  });

  it("a routine runs once at a time, the clock's turn included", async () => {
    const hold = gate();
    const t = await setup(
      runs(() => [
        hold.opened.then(() => report("R", "r")) as unknown as Answer,
      ]),
    );
    const routine = await t.create();
    await t.watch(routine.id);
    t.setClock("2026-10-18T08:59:59Z");
    t.tick();
    t.setClock("2026-10-18T09:00:00Z");
    expect(t.tick()).toEqual([routine.id]);
    await until(() => t.requests.some(isRun));
    expect(t.sections(routine.id).runs()[0]).toMatchObject({
      status: "running",
      startedBy: "schedule",
    });
    t.setClock("2026-10-19T09:00:00Z");
    expect(t.tick()).toEqual([]);
    await expect(t.act("run", { routineId: routine.id })).rejects.toThrow(
      /already running/,
    );
    hold.open();
    await until(() => t.sections(routine.id).runs()[0]?.status === "sent");
    expect(t.sections(routine.id).runs()).toHaveLength(1);
  });

  it("the clock fires a run once at the time, not twice, and not while paused", async () => {
    const t = await setup(runs(() => [report("Tick", "t")]));
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

  it("posts a plain message in a group with post_in_group, waking nobody", async () => {
    let group = "";
    const t = await setup(
      runs(() => [
        call("post_in_group", {
          conversationId: group,
          text: "Weekly: all green.",
        }),
        report("Posted", "Posted the weekly note in the group."),
      ]),
    );
    const ada = await t.w.agent("Ada");
    const project = await t.w.project();
    group = (await t.w.group(project.id, [ada.id], "Room")).id;
    await t.w.watch(group);
    const routine = await t.create({ brief: "Post the weekly note in Room." });
    expect(await t.runNow(routine.id)).toMatchObject({ status: "sent" });
    await until(() => t.w.rows(group).length === 1);
    const row = t.w.rows(group)[0]!;
    expect(row).toMatchObject({
      kind: "message",
      author: "captain",
      agentId: t.captainId,
      text: "Weekly: all green.",
      mentions: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nobody was woken: no reply row, and Ada was never asked.
    expect(t.w.rows(group)).toHaveLength(1);
    expect(t.requests.some((r) => r.agent === "Ada")).toBe(false);
  });
});

describe("the handoff is the next run's alone", () => {
  const MARK = "ZEBRA-7731 check the payroll export";

  it("reaches the next run's prompt in its private block, and no view, tool or notice", async () => {
    const tool: string[] = [];
    const t = await setup(
      runs((run) =>
        run === 0
          ? [report("Payroll", "The export ran."), handoff(MARK)]
          : [
              call("list_runs", {}),
              call("search_runs", { query: "ZEBRA" }),
              call("search_runs", { query: "Payroll" }),
              report("Second", "Checked again."),
            ],
      ),
    );
    const routine = await t.create();
    const first = await t.runNow(routine.id);
    const second = await t.runNow(routine.id);
    // What the second run's tools answered.
    for (const request of t.requests.filter(isRun))
      if (
        request.lastRole === "toolResult" &&
        request.transcript[0]!.includes(PRIVATE_OPEN) &&
        request.transcript[0]!.includes(MARK)
      )
        tool.push(request.last);

    // The second run's prompt: the mark, inside the fence, under a heading that says it is private.
    const prompt = t.requests
      .filter(isRun)
      .find((r) => step(r) === 0 && r.transcript[0]!.includes(MARK))!
      .transcript[0]!;
    const open = prompt.indexOf(PRIVATE_OPEN);
    const close = prompt.indexOf(PRIVATE_CLOSE);
    expect(open).toBeGreaterThan(-1);
    expect(prompt.indexOf(MARK)).toBeGreaterThan(open);
    expect(prompt.indexOf(MARK)).toBeLessThan(close);
    expect(prompt).toContain("## Your private notes from the previous run");
    expect(prompt).toContain(
      "never copy it, quote it or paraphrase it into a report",
    );
    // The mark appears in that prompt once, and nowhere above the fence.
    expect(prompt.split(MARK)).toHaveLength(2);

    // And nowhere a client or a tool can read it.
    const get = await t.w.client.call("captain", "direct", {});
    t.w.client.subscribe("usage");
    await until(() => t.w.client.section("usage", "routines") !== undefined);
    const outward = JSON.stringify({
      list: t.w.client.section("routines", "list"),
      info: t.sections(routine.id).info(),
      briefs: t.sections(routine.id).briefs(),
      runs: t.sections(routine.id).runs(),
      direct: t.w.rows(t.direct),
      hello: (await t.w.client.hello()).state,
      tool,
      get,
      first,
      second,
    });
    expect(outward).not.toContain("ZEBRA");
    expect(tool).toHaveLength(4);
    // The tools answered, without it: list_runs, a search for the mark (nothing), a search for the report (found).
    expect(tool[1]).toBe("No earlier run mentions that.");
    expect(tool[2]).toContain(first.id);
    // It is in the row, where the next run's prompt reads it from.
    expect(t.w.host.product.routines.store.run(first.id)!.handoff).toBe(MARK);
  });

  it("get_run returns the report and the error, never the handoff", async () => {
    let firstId = "";
    const results: string[] = [];
    const t = await setup(
      runs((run) =>
        run === 0
          ? [report("A", "body A"), handoff("SECRET-HANDOFF")]
          : [call("get_run", { run: firstId }), call("no_news", {})],
      ),
    );
    const routine = await t.create();
    firstId = (await t.runNow(routine.id)).id;
    await t.runNow(routine.id);
    for (const request of t.requests.filter(isRun))
      if (request.lastRole === "toolResult") results.push(request.last);
    const got = results.find((r) => r.includes(firstId))!;
    expect(got).toContain("body A");
    expect(got).not.toContain("SECRET-HANDOFF");
    expect(got).not.toContain("handoff");
  });
});

describe("while Captain is off", () => {
  it("a time that comes is a skipped run that says why, run now is refused, the page is told, and nothing is made up", async () => {
    const t = await setup(runs(() => [report("Back", "b")]));
    const routine = await t.create();
    await t.watch(routine.id);
    t.tick();
    t.captain.setSetting("supervisorEnabled", false, null);
    await until(() => t.status()?.captainOn === false);
    expect(t.status()).toEqual({ captainOn: false, reason: "supervisor_off" });

    t.setClock("2026-10-18T09:00:00Z");
    expect(t.tick()).toEqual([]);
    await until(() => t.sections(routine.id).runs().length === 1);
    expect(t.sections(routine.id).runs()[0]).toMatchObject({
      status: "skipped",
      startedBy: "schedule",
      sessionId: null,
      report: null,
      error:
        "Captain is off (its supervisor is switched off), so this run did not happen.",
    });
    expect(t.requests.some(isRun)).toBe(false);
    await expect(t.act("run", { routineId: routine.id })).rejects.toThrow(
      /Captain is off/,
    );

    // Two more days go by off; then Captain is back on: the missed days are not run.
    t.setClock("2026-10-19T09:00:00Z");
    t.tick();
    t.setClock("2026-10-20T08:00:00Z");
    t.tick();
    t.captain.setSetting("supervisorEnabled", true, null);
    await until(() => t.status()?.captainOn === true);
    expect(t.tick()).toEqual([]);
    expect(t.requests.some(isRun)).toBe(false);
    expect(
      t
        .sections(routine.id)
        .runs()
        .map((r) => r.status),
    ).toEqual(["skipped", "skipped"]);
    // Its next time runs.
    t.setClock("2026-10-20T09:00:00Z");
    expect(t.tick()).toEqual([routine.id]);
    await until(() => t.sections(routine.id).runs()[0]?.status === "sent");
  });

  it("counts Captain without a model as off too", async () => {
    const t = await setup(runs([]));
    t.w.host.db
      .query("UPDATE agent SET model = NULL WHERE id = ?")
      .run(t.captainId);
    expect(t.w.host.product.routines.runner.status()).toEqual({
      captainOn: false,
      reason: "no_model",
    });
    const routine = await t.create();
    await expect(t.act("run", { routineId: routine.id })).rejects.toThrow(
      /Captain is off/,
    );
  });
});

describe("a routine Captain proposes from a chat", () => {
  it("draws a card; confirming it makes the routine, rejecting makes nothing", async () => {
    const t = await setup((request) => {
      if (request.agent !== "Captain" || isRun(request)) return say("");
      if (request.last.includes("every Monday"))
        return call("propose_routine", {
          name: "Monday digest",
          brief: "Read the week's tasks and report what moved.",
          schedule: { kind: "weekly", days: [1], time: "09:00" },
          timezone: "Asia/Shanghai",
        });
      return say("Proposed.");
    });
    await t.w.send(t.direct, "every Monday at 9, tell me what moved");
    let card: ReturnType<typeof captainProposalOf<CaptainRoutineProposal>>;
    await until(() => {
      card = t.w
        .rows(t.direct)
        .map(captainProposalOf<CaptainRoutineProposal>)
        .find((c) => c?.kind === "create_routine");
      return card !== undefined;
    });
    expect(card!.proposal).toMatchObject({
      name: "Monday digest",
      brief: "Read the week's tasks and report what moved.",
      schedule: { kind: "weekly", days: [1], time: "09:00" },
      timezone: "Asia/Shanghai",
      scheduleText: "every Mon at 09:00",
      originConversationId: t.direct,
    });
    // Nothing is made before the user says so.
    expect(t.w.host.product.routines.store.list()).toEqual([]);
    const { operation } = (await t.w.client.call("captain", "decideOperation", {
      operationId: card!.operationId,
      decision: "approve",
    })) as { operation: CaptainOperationView };
    expect(operation).toMatchObject({ status: "applied" });
    const made = t.w.host.product.routines.store.list();
    expect(made).toMatchObject([
      { name: "Monday digest", enabled: true, timezone: "Asia/Shanghai" },
    ]);
    expect(operation.result).toMatchObject({ routineId: made[0]!.id });
    await until(
      () =>
        (t.w.client.section<RoutineSummary[]>("routines", "list") ?? [])
          .length === 1,
    );
  });

  it("a proposal that does not hold is refused before any card", async () => {
    const t = await setup(runs([]));
    await expect(
      t.captain.proposals.propose(
        t.captain.propose.routine,
        {
          name: "Bad",
          brief: "x",
          schedule: { kind: "daily", time: "09:00" },
          timezone: "Mars/Base",
        },
        t.direct,
      ),
    ).rejects.toThrow(/unknown time zone/);
  });

  it("update_routine renames, rewrites the brief as a new version, and disables", async () => {
    let id = "";
    const t = await setup((request) => {
      if (request.agent !== "Captain" || isRun(request)) return say("");
      if (step(request) === 0)
        return call("update_routine", {
          routineId: id,
          name: "Renamed",
          brief: "A better brief.",
          enabled: false,
        });
      return say("Done.");
    });
    id = (await t.create()).id;
    await t.watch(id);
    await t.w.send(t.direct, "rename it and pause it");
    await until(() => t.sections(id).briefs().length === 2);
    expect(t.sections(id).briefs()[0]).toMatchObject({
      version: 2,
      text: "A better brief.",
    });
    await until(() => t.sections(id).info().enabled === false);
    expect(t.sections(id).info().name).toBe("Renamed");
  });
});

describe("what a restart settles", () => {
  it("fails a run a dead process left going, with a reason, and lets the routine run again", async () => {
    const dataDir = await tempDir();
    const first = await setup(runs([]), { dataDir } as never);
    const routine = await first.create();
    await first.w.host.close();

    const db = new Database(databasePath(dataDir));
    db.query(
      "INSERT INTO routine_run (id, routine_id, started_by, status, started_at) VALUES ('ghost', ?, 'schedule', 'running', 1)",
    ).run(routine.id);
    db.close();

    const second = await setup(
      runs(() => [report("Back", "b")]),
      {
        dataDir,
      } as never,
    );
    await second.watch(routine.id);
    expect(second.sections(routine.id).runs()[0]).toMatchObject({
      id: "ghost",
      status: "failed",
      error: "The server restarted before this run finished.",
    });
    expect(await second.runNow(routine.id)).toMatchObject({ status: "sent" });
  });

  it("a host that closes under a run fails it as interrupted", async () => {
    const dataDir = await tempDir();
    const t = await setup((request) => (isRun(request) ? HANG : say("")), {
      dataDir,
    } as never);
    const routine = await t.create();
    await t.watch(routine.id);
    await t.act("run", { routineId: routine.id });
    await until(() => t.requests.some(isRun));
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
    const t = await setup(
      runs((run) => (run === 0 ? [report("R", "r")] : [call("no_news", {})])),
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

  it("is made into the next version of the brief on Captain's model, which the next run follows", async () => {
    const t = await setup(
      runs(
        () => [report("R", "the report"), handoff("NOT-FOR-THE-REVISER")],
        (request) =>
          isRevision(request)
            ? say("Summarise the news. Keep it short.")
            : say(""),
      ),
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    await feedbackOn(t, routine.id, run);
    await until(() => t.sections(routine.id).briefs().length === 2);
    expect(t.sections(routine.id).briefs()[0]).toMatchObject({
      version: 2,
      text: "Summarise the news. Keep it short.",
      feedback: "Keep it shorter.",
    });
    const asked = t.requests.find(isRevision)!.transcript.join("\n");
    expect(asked).toContain("Summarise the news.");
    expect(asked).toContain("the report");
    expect(asked).toContain("Keep it shorter.");
    expect(asked).not.toContain("NOT-FOR-THE-REVISER");
    await until(() => !t.sections(routine.id).info().revising);
    await t.runNow(routine.id);
    expect(
      t.requests.filter((r) => isRun(r) && step(r) === 0).at(-1)!.transcript[0],
    ).toContain("(version 2)");
  });

  it("restarts from the newer text when the brief moved while the model was answering", async () => {
    let revisions = 0;
    const t: Awaited<ReturnType<typeof setup>> = await setup(
      runs(
        () => [report("R", "r")],
        async (request) => {
          if (!isRevision(request)) return say("");
          revisions += 1;
          if (revisions === 1) {
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
      ),
    );
    const routine = await t.create();
    const run = await t.runNow(routine.id);
    await feedbackOn(t, routine.id, run);
    await until(() => t.sections(routine.id).briefs().length === 3);
    expect(
      t
        .sections(routine.id)
        .briefs()
        .map((b) => b.text),
    ).toEqual([
      "A person rewrote it. And shorter.",
      "A person rewrote it.",
      "Summarise the news.",
    ]);
  });

  it("is refused for a run still going, a run of another routine, or nothing", async () => {
    const hold = gate();
    const t = await setup(
      runs((run) =>
        run === 0
          ? [hold.opened.then(() => report("R", "r")) as unknown as Answer]
          : [report("R", "r")],
      ),
    );
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
  });
});

describe("what a routine's run costs", () => {
  it("is counted under the routine, with Captain as the agent and no conversation", async () => {
    const t = await setup(runs(() => [report("News", "ok")]));
    const routine = await t.create();
    await t.runNow(routine.id);
    const rows = t.w.host.db
      .query<
        {
          agent_id: string | null;
          routine_id: string | null;
          conversation_id: string | null;
        },
        []
      >("SELECT agent_id, routine_id, conversation_id FROM usage")
      .all()
      .filter((row) => row.routine_id !== null);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row).toEqual({
        agent_id: t.captainId,
        routine_id: routine.id,
        conversation_id: null,
      });
    t.w.client.subscribe("usage");
    await until(() => t.w.client.section("usage", "routines") !== undefined);
    expect(
      t.w.client.section<RoutineUsage[]>("usage", "routines")![0],
    ).toMatchObject({ routineId: routine.id });
  });
});
