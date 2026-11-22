/**
 * With "react to results" on, a task's result wakes the agent that made it, once, to review it.
 * Off (the default), or for a task the user made or one its maker executes itself, the
 * result is only posted. Every test is a real host with
 * scripted models: Bea executes and finishes, Ada made the task.
 */
import type { BoardTaskDetail, TaskBoardSettings } from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
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
