/**
 * With "react to results" on, a task's result wakes the agent that made it to review it, request
 * bounded automatic rework (`request_task_changes`), or report its conclusion (`report_task_review`)
 * to the origin group while leaving the task `in_review`. Off (the default), or for a task the user
 * made or one its maker executes itself, the result is only posted. Every test is a real host with
 * scripted models: Bea executes and finishes, Ada made the task.
 */
import type { BoardTaskDetail, TaskBoardSettings } from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const onTask = (request: Request): boolean =>
  request.system.includes("In this task you are");

const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));

async function room(
  options: {
    react?: boolean;
    by?: "maker" | "self" | "user";
    status?: "in_review" | "blocked";
  } = {},
) {
  const { models, requests } = scriptedModels((request) => {
    if (!onTask(request)) return say("ok");
    if (request.agent === "Ada") return say("looks fine");
    if (request.lastRole === "toolResult") return say("ok");
    return call("finish_task", {
      summary: "Painted it teal.",
      status: options.status ?? "in_review",
    });
  });
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const bea = await w.agent("Bea");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id, bea.id], "ui");
  await w.watch(group.id);
  if (options.react === true)
    await w.client.call("tasks", "setSettings", { reactToResults: true });
  const add = (by: "maker" | "self" | "user"): BoardTaskDetail => {
    const base = {
      title: "Paint it",
      description: "Paint it teal.",
      status: "todo",
      conversationId: group.id,
      workspace: "local" as const,
    };
    // The user's task is made the user's way, and names its executor; an agent's names its maker.
    return by === "user"
      ? w.host.product.board.make(
          {
            tasks: [
              {
                title: base.title,
                description: base.description,
                assignee: "Bea",
              },
            ],
            conversationId: group.id,
            workspace: "local",
          },
          { kind: "user", agentId: null },
        )[0]!
      : w.host.product.board.create(
          { ...base, ...(by === "self" ? {} : { assignee: "Bea" }) },
          { kind: "agent", agentId: by === "self" ? bea.id : ada.id },
        );
  };
  return { w, task: add(options.by ?? "maker"), requests, add };
}

const finished = async (r: { w: World; task: BoardTaskDetail }) => {
  await until(
    () => r.w.host.product.board.detail(r.task.id)?.status !== "todo",
  );
  await quiet();
};

const adaRuns = (r: { requests: Request[] }) =>
  r.requests.filter((request) => request.agent === "Ada" && onTask(request));

const wakeComments = (r: { w: World; task: BoardTaskDetail }): string[] =>
  r.w.host.product.board
    .activity(r.task.id)
    .filter(
      (entry) =>
        entry.kind === "comment" &&
        entry.actor.kind === "system" &&
        (entry.body ?? "").includes("was woken to review"),
    )
    .map((entry) => entry.body ?? "");

describe("a finished task and the agent that made it", () => {
  it("wakes the maker once, who reads the result, and its reply wakes nobody", async () => {
    const r = await room({ react: true });
    await until(() => adaRuns(r).length > 0);
    await finished(r);
    expect(adaRuns(r)).toHaveLength(1);
    expect(adaRuns(r)[0]).toMatchObject({ agent: "Ada" });
    expect(JSON.stringify(adaRuns(r)[0])).toContain("Painted it teal.");
    // The wake is Ada's one run; it leaves no system comment on the timeline.
    expect(wakeComments(r)).toEqual([]);
    expect(r.w.host.product.board.detail(r.task.id)?.status).toBe("in_review");
  });

  it("wakes the maker for a blocked result too", async () => {
    const r = await room({ react: true, status: "blocked" });
    await until(() => adaRuns(r).length > 0);
    await finished(r);
    expect(adaRuns(r)).toHaveLength(1);
    expect(JSON.stringify(adaRuns(r)[0])).toContain("blocked");
  });

  it("does nothing while the setting is off, which is the default", async () => {
    const r = await room();
    await finished(r);
    expect(adaRuns(r)).toHaveLength(0);
    expect(wakeComments(r)).toEqual([]);
  });

  it("leaves a task its executor made itself, and the user's task, alone", async () => {
    for (const by of ["self", "user"] as const) {
      const r = await room({ react: true, by });
      await finished(r);
      expect(adaRuns(r)).toHaveLength(0);
      expect(wakeComments(r)).toEqual([]);
    }
  });

  it("takes the setting at the next finish_task, without a restart", async () => {
    const off = await room();
    await finished(off);
    expect(adaRuns(off)).toHaveLength(0);
    const saved = (await off.w.client.call("tasks", "setSettings", {
      reactToResults: true,
    })) as { settings: TaskBoardSettings };
    expect(saved.settings.reactToResults).toBe(true);
    // The next task to finish wakes its maker; nothing was restarted.
    const again = off.add("maker");
    await until(() => adaRuns(off).length > 0);
    await until(
      () => off.w.host.product.board.detail(again.id)?.status !== "todo",
    );
    await expect(
      off.w.client.call("tasks", "setSettings", { reactToResults: "yes" }),
    ).rejects.toThrow(/reactToResults/);
  });
});

describe("review loop with request_task_changes and report_task_review", () => {
  it("supports bounded request_task_changes rework in the executor's session and report_task_review to the group without waking other agents", async () => {
    const toolResults: { agent: string; text: string }[] = [];
    let beaSubmissions = 0;
    let adaReviews = 0;
    const { models, requests } = scriptedModels((request) => {
      if (!onTask(request)) return say("chat reply");
      if (request.lastRole === "toolResult") {
        toolResults.push({
          agent: request.agent ?? "?",
          text: request.last,
        });
        return say("done");
      }
      if (request.agent === "Bea") {
        beaSubmissions += 1;
        return call("finish_task", {
          summary:
            beaSubmissions === 1
              ? "Initial implementation."
              : "Fixed edge cases.",
        });
      }
      if (request.agent === "Ada") {
        adaReviews += 1;
        if (adaReviews === 1)
          return call("request_task_changes", {
            feedback: "Handle empty input before finishing.",
            notifyGroup: "Sent back for empty-input handling.",
          });
        return call("report_task_review", {
          summary:
            "Looks solid after fixes; ready for your final confirmation.",
        });
      }
      return say("unexpected");
    });

    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bea = await w.agent("Bea");
    const cora = await w.agent("Cora");
    const project = await w.project();
    const group = await w.group(
      project.id,
      [ada.id, bea.id, cora.id],
      "review",
    );
    await w.watch(group.id);
    await w.client.call("tasks", "setSettings", { reactToResults: true });

    const task = w.host.product.board.create(
      {
        title: "Validate input",
        description: "Reject empty input cleanly.",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        assignee: bea.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    await until(() => {
      const detail = w.host.product.board.detail(task.id);
      return (
        detail?.status === "in_review" &&
        detail.runs.filter((run) => run.agentId === null).length === 2 &&
        detail.runs.filter((run) => run.agentId === ada.id).length === 2 &&
        detail.runs.every((run) => run.status === "completed")
      );
    });
    await quiet();

    const detail = w.host.product.board.detail(task.id)!;
    // Task remains in_review for the user's final confirmation (never auto-marked done).
    expect(detail.status).toBe("in_review");

    // Executor reworked in its original session (`continuesRunId` points to run 1).
    const beaRuns = detail.runs.filter((run) => run.agentId === null);
    expect(beaRuns).toHaveLength(2);
    expect(beaRuns[1]!.continuesRunId).toBe(beaRuns[0]!.id);
    expect(beaRuns[1]!.sessionId).toBe(beaRuns[0]!.sessionId);

    // Structured review metadata is persisted on task_activity.
    const reviewComments = w.host.product.board
      .activity(task.id)
      .filter(
        (entry) =>
          entry.kind === "comment" && entry.data.reviewAction !== undefined,
      );
    expect(reviewComments).toHaveLength(2);
    expect(reviewComments[0]).toMatchObject({
      actor: { kind: "agent", agentId: ada.id },
      body: "Handle empty input before finishing.",
      data: { reviewAction: "request_changes", round: 1, maxRounds: 3 },
    });
    expect(reviewComments[1]).toMatchObject({
      actor: { kind: "agent", agentId: ada.id },
      body: "Looks solid after fixes; ready for your final confirmation.",
      data: { reviewAction: "report", round: 1, maxRounds: 3 },
    });

    // Wake prompts include round budget and no misleading `mark the task done` / `draft` guidance.
    const adaBriefs = requests.filter(
      (req) =>
        req.agent === "Ada" && onTask(req) && req.lastRole !== "toolResult",
    );
    expect(adaBriefs[0]!.last).toContain("0/3");
    expect(adaBriefs[0]!.last).toContain("request_task_changes");
    expect(adaBriefs[0]!.last).toContain("report_task_review");
    expect(adaBriefs[0]!.last).not.toMatch(/mark the task done/i);
    expect(adaBriefs[0]!.last).not.toMatch(/\bdraft\b/i);
    expect(adaBriefs[1]!.last).toContain("1/3");
    // Executor saw the maker's feedback on rework.
    expect(
      requests.find(
        (req) =>
          req.agent === "Bea" &&
          onTask(req) &&
          req.transcript
            .join("\n")
            .includes("Handle empty input before finishing."),
      ),
    ).toBeDefined();

    // Group chat got both the optional notifyGroup update and the final task_review report,
    // without waking any group chat agent (including Cora).
    const reviewRows = w
      .rows(group.id)
      .filter((row) => row.data.event === "task_review");
    expect(reviewRows).toHaveLength(2);
    expect(reviewRows[0]).toMatchObject({
      author: "agent",
      agentId: ada.id,
      data: { event: "task_review", taskId: task.id },
    });
    expect(reviewRows[0]!.text).toContain(
      "Sent back for empty-input handling.",
    );
    expect(reviewRows[1]!.text).toContain(
      "Looks solid after fixes; ready for your final confirmation.",
    );
    expect(requests.filter((req) => !onTask(req))).toHaveLength(0);
    expect(requests.filter((req) => req.agent === "Cora")).toHaveLength(0);
    expect(toolResults.some((r) => r.agent === "Ada")).toBe(true);
  });

  it("refuses a second request_task_changes within the same review run", async () => {
    let adaStep = 0;
    const adaResults: string[] = [];
    const { models } = scriptedModels((request) => {
      if (!onTask(request)) return say("ok");
      if (request.agent === "Bea")
        return request.lastRole === "toolResult"
          ? say("ok")
          : call("finish_task", { summary: "Done." });
      if (request.agent === "Ada") {
        if (request.lastRole === "toolResult") adaResults.push(request.last);
        adaStep += 1;
        if (adaStep === 1)
          return call("request_task_changes", { feedback: "Fix A." });
        if (adaStep === 2)
          return call("request_task_changes", { feedback: "Fix B too." });
        return say("waited");
      }
      return say("ok");
    });

    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bea = await w.agent("Bea");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bea.id], "single-run");
    await w.watch(group.id);
    await w.client.call("tasks", "setSettings", { reactToResults: true });

    const task = w.host.product.board.create(
      {
        title: "One per review",
        description: "Check single-run limit.",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        assignee: bea.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    await until(() => adaResults.length >= 2);
    await until(() => {
      const detail = w.host.product.board.detail(task.id);
      return (
        detail?.status === "in_review" &&
        detail.runs.every((run) => run.status === "completed")
      );
    });

    expect(adaResults[0]).toContain("round 1/3");
    expect(adaResults[1]).toMatch(/already requested changes/i);
    const changes = w.host.product.board
      .activity(task.id)
      .filter((entry) => entry.data.reviewAction === "request_changes");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.body).toBe("Fix A.");
  });

  it("enforces reviewMaxRounds across restarts and guides fallback to report_task_review", async () => {
    const dataDir = await tempDir();
    let phase1Bea = 0;
    let phase1Ada = 0;
    const phase1 = scriptedModels((request) => {
      if (!onTask(request)) return say("ok");
      if (request.lastRole === "toolResult") return say("ok");
      if (request.agent === "Bea") {
        phase1Bea += 1;
        return call("finish_task", { summary: `Build v${phase1Bea}` });
      }
      phase1Ada += 1;
      if (phase1Ada === 1)
        return call("request_task_changes", { feedback: "Round 1 fix." });
      return call("report_task_review", {
        summary: "Pausing after round 1.",
        postToGroup: false,
      });
    });

    const first = await world({ dataDir, models: phase1.models });
    const ada = await first.agent("Ada");
    const bea = await first.agent("Bea");
    const cora = await first.agent("Cora");
    const project = await first.project();
    const group = await first.group(
      project.id,
      [ada.id, bea.id, cora.id],
      "restart",
    );
    await first.watch(group.id);
    await first.client.call("tasks", "setSettings", {
      reactToResults: true,
      reviewMaxRounds: 2,
    });

    const task = first.host.product.board.create(
      {
        title: "Persist rounds",
        description: "Survive restart.",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        assignee: bea.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    await until(() => {
      const detail = first.host.product.board.detail(task.id);
      return (
        detail?.status === "in_review" &&
        detail.runs.filter((run) => run.agentId === ada.id).length === 2 &&
        detail.runs.every((run) => run.status === "completed")
      );
    });
    await first.host.close();

    // Restart on the same dataDir: setting (2) and used round count (1) must survive.
    const rejectedErrors: string[] = [];
    let phase2AdaRuns = 0;
    const phase2 = scriptedModels((request) => {
      if (!onTask(request)) return say("unexpected chat");
      if (request.agent === "Bea")
        return request.lastRole === "toolResult"
          ? say("ok")
          : call("finish_task", { summary: "Updated after restart." });
      if (request.agent === "Ada") {
        if (request.lastRole === "toolResult") {
          if (request.last.includes("report_task_review")) {
            rejectedErrors.push(request.last);
            return call("report_task_review", {
              summary: "Hit 2/2 limit; handing off to user.",
            });
          }
          return say("ok");
        }
        phase2AdaRuns += 1;
        // Both first and second post-restart review try `request_task_changes`:
        // 1st succeeds (round 2/2), 2nd is rejected (2/2 limit) and falls back to `report_task_review`.
        return call("request_task_changes", {
          feedback: `Post-restart check #${phase2AdaRuns}.`,
        });
      }
      return say("ok");
    });

    const second = await world({ dataDir, models: phase2.models });
    await second.watch(group.id);
    const readSettings = (await second.client.call(
      "tasks",
      "setSettings",
      {},
    )) as { settings: TaskBoardSettings };
    expect(readSettings.settings).toMatchObject({
      reactToResults: true,
      reviewMaxRounds: 2,
    });

    // Wake Bea via a user comment so finish_task triggers Ada's review with persisted 1/2 count.
    await second.client.call("tasks", "comment", {
      taskId: task.id,
      body: "Please run one more check after restart.",
    });

    await until(() => {
      const detail = second.host.product.board.detail(task.id);
      return (
        detail?.status === "in_review" &&
        rejectedErrors.length === 1 &&
        detail.runs.every((run) => run.status === "completed")
      );
    });
    await quiet();

    expect(rejectedErrors[0]).toContain("2/2");
    expect(rejectedErrors[0]).toContain("report_task_review");
    expect(second.host.product.board.detail(task.id)!.status).toBe("in_review");
    const requestChanges = second.host.product.board
      .activity(task.id)
      .filter((entry) => entry.data.reviewAction === "request_changes");
    expect(requestChanges.map((e) => e.data)).toEqual([
      { reviewAction: "request_changes", round: 1, maxRounds: 2 },
      { reviewAction: "request_changes", round: 2, maxRounds: 2 },
    ]);
    const groupReviews = second
      .rows(group.id)
      .filter((row) => row.data.event === "task_review");
    expect(groupReviews).toHaveLength(1);
    expect(groupReviews[0]!.text).toContain(
      "Hit 2/2 limit; handing off to user.",
    );
    expect(phase2.requests.filter((req) => !onTask(req))).toHaveLength(0);
    expect(phase2.requests.filter((req) => req.agent === "Cora")).toHaveLength(
      0,
    );
  });

  it("disables automatic rework when reviewMaxRounds is 0 and respects postToGroup: false", async () => {
    const errors: string[] = [];
    const { models, requests } = scriptedModels((request) => {
      if (!onTask(request)) return say("ok");
      if (request.agent === "Bea")
        return request.lastRole === "toolResult"
          ? say("ok")
          : call("finish_task", { summary: "Finished v1." });
      if (request.agent === "Ada") {
        if (request.lastRole === "toolResult") {
          if (request.last.includes("disabled (0/0")) {
            errors.push(request.last);
            return call("report_task_review", {
              summary: "Silent task-only review note.",
              postToGroup: false,
            });
          }
          return say("ok");
        }
        return call("request_task_changes", { feedback: "Should be blocked." });
      }
      return say("ok");
    });

    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bea = await w.agent("Bea");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bea.id], "zero-rounds");
    await w.watch(group.id);
    await w.client.call("tasks", "setSettings", {
      reactToResults: true,
      reviewMaxRounds: 0,
    });

    const task = w.host.product.board.create(
      {
        title: "Zero rounds",
        description: "Report only.",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        assignee: bea.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    await until(() => errors.length === 1);
    await until(() => {
      const detail = w.host.product.board.detail(task.id);
      return (
        detail?.status === "in_review" &&
        detail.runs.every((run) => run.status === "completed")
      );
    });
    await quiet();

    expect(errors[0]).toContain("report_task_review");
    const adaPrompt = requests.find(
      (req) =>
        req.agent === "Ada" && onTask(req) && req.lastRole !== "toolResult",
    )!;
    expect(adaPrompt.last).toContain("0/0");
    // Bea only ran once (request_task_changes did NOT wake her).
    expect(
      w.host.product.board
        .detail(task.id)!
        .runs.filter((run) => run.agentId === null),
    ).toHaveLength(1);
    // postToGroup: false recorded on task timeline without adding a task_review message to the group.
    const reports = w.host.product.board
      .activity(task.id)
      .filter((entry) => entry.data.reviewAction === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.body).toBe("Silent task-only review note.");
    expect(
      w.rows(group.id).filter((row) => row.data.event === "task_review"),
    ).toHaveLength(0);
  });

  it("keeps comment_task non-waking for makers and refuses request_task_changes when not workable", async () => {
    // 1. comment_task by maker keeps wake: false.
    const firstModels = scriptedModels((request) => {
      if (!onTask(request)) return say("ok");
      if (request.agent === "Bea")
        return request.lastRole === "toolResult"
          ? say("ok")
          : call("finish_task", { summary: "Done." });
      if (request.agent === "Ada")
        return request.lastRole === "toolResult"
          ? say("noted")
          : call("comment_task", { body: "Silent maker comment." });
      return say("ok");
    });
    const w1 = await world({ models: firstModels.models });
    const ada1 = await w1.agent("Ada");
    const bea1 = await w1.agent("Bea");
    const p1 = await w1.project();
    const g1 = await w1.group(p1.id, [ada1.id, bea1.id], "comment-only");
    await w1.watch(g1.id);
    await w1.client.call("tasks", "setSettings", { reactToResults: true });
    const t1 = w1.host.product.board.create(
      {
        title: "Silent comment",
        description: "No wake.",
        status: "todo",
        conversationId: g1.id,
        workspace: "local",
        assignee: bea1.id,
      },
      { kind: "agent", agentId: ada1.id },
    );
    await until(() => {
      const detail = w1.host.product.board.detail(t1.id);
      return (
        detail?.runs.filter((run) => run.agentId === ada1.id).length === 1 &&
        detail.runs.every((run) => run.status === "completed")
      );
    });
    await quiet();
    expect(
      w1.host.product.board
        .detail(t1.id)!
        .runs.filter((run) => run.agentId === null),
    ).toHaveLength(1);

    // 2. Non-workable task (`backlog`) refuses request_task_changes during an active review run.
    const reviewArrived = gate();
    const releaseReview = gate();
    const nonWorkableErrors: string[] = [];
    const secondModels = scriptedModels(async (request) => {
      if (!onTask(request)) return say("ok");
      if (request.agent === "Bea")
        return request.lastRole === "toolResult"
          ? say("ok")
          : call("finish_task", { summary: "Ready." });
      if (request.agent === "Ada") {
        if (request.lastRole === "toolResult") {
          nonWorkableErrors.push(request.last);
          return say("ok");
        }
        reviewArrived.open();
        await releaseReview.opened;
        return call("request_task_changes", { feedback: "Too late." });
      }
      return say("ok");
    });
    const w2 = await world({ models: secondModels.models });
    const ada2 = await w2.agent("Ada");
    const bea2 = await w2.agent("Bea");
    const p2 = await w2.project();
    const g2 = await w2.group(p2.id, [ada2.id, bea2.id], "already-backlog");
    await w2.watch(g2.id);
    await w2.client.call("tasks", "setSettings", { reactToResults: true });
    const t2 = w2.host.product.board.create(
      {
        title: "Move off workable before review",
        description: "Backlog early.",
        status: "todo",
        conversationId: g2.id,
        workspace: "local",
        assignee: bea2.id,
      },
      { kind: "agent", agentId: ada2.id },
    );
    await reviewArrived.opened;
    await w2.client.call("tasks", "update", {
      taskId: t2.id,
      status: "backlog",
    });
    releaseReview.open();
    await until(() => nonWorkableErrors.length === 1);
    expect(nonWorkableErrors[0]).toMatch(/\[backlog\].*cannot be woken/);
  });

  it("reads, saves, and validates reviewMaxRounds via tasks.setSettings", async () => {
    const r = await room();
    const read = () =>
      r.w.client.call("tasks", "setSettings", {}) as Promise<{
        settings: TaskBoardSettings;
      }>;
    expect((await read()).settings.reviewMaxRounds).toBe(3);

    for (const valid of [0, 10, 4]) {
      const saved = (await r.w.client.call("tasks", "setSettings", {
        reviewMaxRounds: valid,
      })) as { settings: TaskBoardSettings };
      expect(saved.settings.reviewMaxRounds).toBe(valid);
    }

    for (const bad of [-1, 11, 1.5, "3", null]) {
      await expect(
        r.w.client.call("tasks", "setSettings", { reviewMaxRounds: bad }),
      ).rejects.toThrow(/reviewMaxRounds is a whole number from 0 to 10/);
    }
    // Atomic check: an invalid reviewMaxRounds refuses the sibling valid field too.
    await expect(
      r.w.client.call("tasks", "setSettings", {
        reactToResults: true,
        reviewMaxRounds: 99,
      }),
    ).rejects.toThrow(/reviewMaxRounds/);
    expect((await read()).settings).toMatchObject({
      reactToResults: false,
      reviewMaxRounds: 4,
    });
  });
});
