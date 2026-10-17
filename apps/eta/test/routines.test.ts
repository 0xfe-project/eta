import type { Host } from "../src/host";
/**
 * Routines (REFACTOR.md §9, P3.3).
 *
 * Three claims.
 *
 * The board: a routine has a brief with versions, runs with reports, and the counts that put a badge
 * on it — and a run's report is what the next run is handed.
 *
 * The clock: a routine that is due runs, one that is paused does not, one that was removed leaves
 * the clock, and a gap is not filled — a firing that was missed stays missed, because three reports
 * nobody asked for is worse than one that never happened.
 *
 * The bridge: an agent in a conversation can create a routine, run it now, and leave feedback — and
 * feedback revises the brief through a model call, from the version it was written against.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations } from "../src/db/migrations";
import { assembleHost } from "../src/host";
import { Scheduler } from "../src/routines/scheduler";
import { RoutineStore } from "../src/routines/store";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const CONFIG = {
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m1" }],
    },
  ],
  defaultModel: "local:m1",
};

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

/** A run as a list shows it: no report, no feedback. */
interface ListedRun {
  id: string;
  status: string;
  title: string | null;
}

/** The list's shape: summaries, with the counters a badge needs. */
interface RoutineSummary {
  id: string;
  name: string;
  enabled: boolean;
  next_run_at: string | null;
  revising: boolean;
  unseen_reports: number;
  unseen_failures: number;
  runs: ListedRun[];
}

/** One routine's page. */
interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  next_run_at: string | null;
  briefs: { version: number; text: string; feedback: string | null }[];
  handoff: { text: string } | null;
  runs: Run[];
}

/** A run in full, as a routine's page reads it. */
interface Run extends ListedRun {
  report: string | null;
  error: string | null;
  feedback: {
    text: string;
    brief_version: number | null;
    revision_failed: boolean;
  }[];
}

/** A model whose answer is a script: one answer per question it is asked. */
const scripted = (answers: string[]) =>
  fakeModels(
    answers.map((text) =>
      assistantMessage({ content: [{ type: "text", text }] }),
    ),
  );

/** A model that calls `finish` with a report, which is what a disciplined run does. */
const finishingModels = (report: string, handoff?: string) =>
  fakeModels([
    assistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall" as const,
          id: "call-finish",
          name: "finish",
          arguments: { report, ...(handoff === undefined ? {} : { handoff }) },
        },
      ],
    }),
    assistantMessage({ content: [{ type: "text", text: "（已结束）" }] }),
  ]);

async function start(models: ReturnType<typeof fakeModels>): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-routines-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
    models,
  });
  hosts.push(host);
  return host;
}

const wait = async (host: Host, routineId: string): Promise<Run[]> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const routine = (await (
      await send(host, "GET", `/api/routines/v1/routines/${routineId}`)
    ).json()) as Routine;
    const busy = routine.runs.some((run) => run.status === "running");
    if (!busy || Date.now() > deadline) return routine.runs;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("a routine belongs to a group", () => {
  it("keeps the group it was made in, and says so in the list", async () => {
    const host = await start();
    const group = (await (
      await send(host, "POST", "/groups", { name: "app" })
    ).json()) as { group: { id: string } };
    const created = await send(host, "POST", "/api/routines/v1/routines", {
      name: "日报",
      brief: "整理三条",
      model: "local:m1",
      timezone: "Asia/Shanghai",
      schedule: { kind: "daily", time: "09:00" },
      group_id: group.group.id,
    });
    expect(created.status).toBe(201);

    const list = (await (
      await send(host, "GET", "/api/routines/v1/routines")
    ).json()) as { routines: { id: string; group_id: string | null }[] };
    expect(list.routines[0]?.group_id).toBe(group.group.id);

    // One made without a group says null — it is the all-groups case, not a guess.
    const loose = await send(host, "POST", "/api/routines/v1/routines", {
      name: "无主",
      brief: "随便",
      model: "local:m1",
      timezone: "Asia/Shanghai",
      schedule: { kind: "daily", time: "10:00" },
    });
    expect(loose.status).toBe(201);
    const after = (await (
      await send(host, "GET", "/api/routines/v1/routines")
    ).json()) as { routines: { name: string; group_id: string | null }[] };
    expect(after.routines.find((r) => r.name === "无主")?.group_id).toBeNull();
  });
});

describe("the board", () => {
  it("creates a routine with its first brief, and versions follow", async () => {
    const host = await start(scripted([]));
    const created = (await (
      await send(host, "POST", "/api/routines/v1/routines", {
        name: "每日简报",
        brief: "看一眼今天的日程和邮件，写三行总结。",
        model: "local:m1",
        schedule: { kind: "daily", time: "07:30" },
        timezone: "Asia/Shanghai",
      })
    ).json()) as Routine;
    expect(created.briefs.map((brief) => brief.version)).toEqual([1]);
    expect(created.briefs[0]?.feedback).toBeNull();

    // Editing the brief makes a second version; the first stays as history.
    const edited = (await (
      await send(host, "PATCH", `/api/routines/v1/routines/${created.id}`, {
        brief: "看日程、邮件和周报，写五句。",
      })
    ).json()) as Routine;
    expect(edited.briefs.map((brief) => brief.version)).toEqual([2, 1]);

    // Restoring the old one makes it the newest, so the history still tells the story.
    const restored = (await (
      await send(
        host,
        "POST",
        `/api/routines/v1/routines/${created.id}/briefs/1/restore`,
      )
    ).json()) as Routine;
    expect(restored.briefs[0]?.version).toBe(3);
    expect(restored.briefs[0]?.text).toContain("三行总结");
  });

  it("counts what the user has not seen, and clears it when they look", async () => {
    const host = await start(finishingModels("今天的简报：无事。"));
    const created = (await (
      await send(host, "POST", "/api/routines/v1/routines", {
        name: "简报",
        brief: "写简报。",
        model: "local:m1",
        schedule: { kind: "daily", time: "07:30" },
        timezone: "Asia/Shanghai",
      })
    ).json()) as Routine;
    await send(host, "POST", `/api/routines/v1/routines/${created.id}/run`);

    const deadline = Date.now() + 5_000;
    let runs = await wait(host, created.id);
    while (
      runs.every((run) => run.status !== "sent") &&
      Date.now() < deadline
    ) {
      runs = await wait(host, created.id);
    }
    let summary = (await (
      await send(host, "GET", "/api/routines/v1/routines")
    ).json()) as { routines: RoutineSummary[] };
    expect(summary.routines[0]?.unseen_reports).toBe(1);

    await send(host, "POST", `/api/routines/v1/routines/${created.id}/seen`);
    summary = (await (
      await send(host, "GET", "/api/routines/v1/routines")
    ).json()) as { routines: RoutineSummary[] };
    expect(summary.routines[0]?.unseen_reports).toBe(0);
  });
});

describe("the clock", () => {
  it("runs what is due, and does not run it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-routines-clock-"));
    roots.push(root);
    const handle = new Database(join(root, "eta.sqlite"));
    applyMigrations(handle, await loadMigrations());
    const store = new RoutineStore(handle);
    const routine = store.create({
      name: "每小时的活",
      model: "local:m1",
      brief: "做事。",
      schedule: { kind: "hourly", every: 1 },
      timezone: "UTC",
    });

    const ran: string[] = [];
    let now = new Date("2026-10-16T07:00:00Z");
    const scheduler = new Scheduler({
      routines: store,
      run: (routineId) => ran.push(routineId),
      tickMs: 1,
      now: () => now,
    });
    scheduler.start();
    // The next run is at 08:00; a tick at 07:01 does nothing, one at 08:00 fires once.
    now = new Date("2026-10-16T07:01:00Z");
    await scheduler.tick(now);
    expect(ran).toEqual([]);
    now = new Date("2026-10-16T08:00:00Z");
    await scheduler.tick(now);
    expect(ran).toEqual([routine.id]);

    // Re-armed from now, not from the due time: the same hour does not fire twice.
    await scheduler.tick(now);
    expect(ran).toEqual([routine.id]);

    // A pause takes it off the clock, so nothing fires into a paused routine.
    store.update(routine.id, { enabled: false });
    scheduler.sync();
    now = new Date("2026-10-16T09:00:00Z");
    await scheduler.tick(now);
    expect(ran).toEqual([routine.id]);
    scheduler.stop();
    handle.close();
  });

  it("fails what a crash left running, so the routine can start again", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-routines-recover-"));
    roots.push(root);
    const handle = new Database(join(root, "eta.sqlite"));
    applyMigrations(handle, await loadMigrations());
    const store = new RoutineStore(handle);
    const routine = store.create({
      name: "被中断的",
      model: "local:m1",
      brief: "做事。",
      schedule: { kind: "daily", time: "07:30" },
      timezone: "UTC",
    });
    store.startRun(routine.id, new Date("2026-10-15T07:30:00Z"));
    expect(store.startRun(routine.id)).toBeUndefined();

    const recovered = store.recover(new Date("2026-10-16T08:00:00Z"));
    expect(recovered.map((run) => run.error)).toEqual([
      "运行被中断（服务重启）。",
    ]);
    // And it can start again: the once-at-a-time rule is not a permanent lock.
    expect(
      store.startRun(routine.id, new Date("2026-10-16T09:00:00Z")),
    ).toBeDefined();
    handle.close();
  });
});

describe("a run", () => {
  it("reports what finish says, and hands the next run its note", async () => {
    const host = await start(
      finishingModels("今天的简报：三件事。", "上次说到一半的邮件还没回。"),
    );
    const created = (await (
      await send(host, "POST", "/api/routines/v1/routines", {
        name: "简报",
        brief: "写简报。",
        model: "local:m1",
        schedule: { kind: "daily", time: "07:30" },
        timezone: "Asia/Shanghai",
      })
    ).json()) as Routine;
    await send(host, "POST", `/api/routines/v1/routines/${created.id}/run`);
    const runs = await wait(host, created.id);
    expect(runs[0]).toMatchObject({ status: "sent" });

    // The routine's page says what the next run was handed: the run's own words.
    const detail = (await (
      await send(host, "GET", `/api/routines/v1/routines/${created.id}`)
    ).json()) as Routine;
    expect(detail.handoff?.text).toBe("上次说到一半的邮件还没回。");
  });

  it("takes the last message as the report when the run never called finish", async () => {
    const host = await start(scripted(["今天没有值得说的事。"]));
    const created = (await (
      await send(host, "POST", "/api/routines/v1/routines", {
        name: "安静的",
        brief: "看看有没有新东西。",
        model: "local:m1",
        schedule: { kind: "daily", time: "07:30" },
        timezone: "Asia/Shanghai",
      })
    ).json()) as Routine;
    await send(host, "POST", `/api/routines/v1/routines/${created.id}/run`);
    const runs = await wait(host, created.id);
    expect(runs[0]?.status).toBe("sent");
    expect(runs[0]?.title).toBe("今天没有值得说的事。");
  });
});

describe("feedback", () => {
  it("revises the brief from the version it was written against", async () => {
    // Two answers: the run itself says something, then the revision turns the feedback into text.
    const host = await start(
      scripted([
        "今天的简报：三件事。",
        "修订后的要求：简报只写三行，不要寒暄。",
      ]),
    );
    const created = (await (
      await send(host, "POST", "/api/routines/v1/routines", {
        name: "简报",
        brief: "写简报。",
        model: "local:m1",
        schedule: { kind: "daily", time: "07:30" },
        timezone: "Asia/Shanghai",
      })
    ).json()) as Routine;
    await send(host, "POST", `/api/routines/v1/routines/${created.id}/run`);
    const runs = await wait(host, created.id);
    const runId = runs[0]?.id;

    const accepted = await send(
      host,
      "POST",
      `/api/routines/v1/routines/${created.id}/runs/${runId}/feedback`,
      { text: "简报太长，只要三行。" },
    );
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(
      201,
    );

    // The revision is a background model call. Wait for the thing being asserted — the new
    // version — rather than for `revising`, which is false both before the call starts and after
    // it ends.
    const deadline = Date.now() + 5_000;
    let detail = (await (
      await send(host, "GET", `/api/routines/v1/routines/${created.id}`)
    ).json()) as Routine;
    while (detail.briefs.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      detail = (await (
        await send(host, "GET", `/api/routines/v1/routines/${created.id}`)
      ).json()) as Routine;
    }
    // `revising` is a summary field (the list is where a page watches for it), not a detail one.
    const listed = (await (
      await send(host, "GET", "/api/routines/v1/routines")
    ).json()) as { routines: RoutineSummary[] };
    expect(listed.routines[0]?.revising).toBe(false);
    expect(detail.briefs.map((brief) => brief.version)).toEqual([2, 1]);
    expect(detail.briefs[0]?.feedback).toContain("只要三行");
    // The feedback itself records which version it produced.
    const run = detail.runs.find((entry) => entry.id === runId);
    expect(run?.feedback[0]).toMatchObject({
      brief_version: 2,
      revision_failed: false,
    });
  });
});
