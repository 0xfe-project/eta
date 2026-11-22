/**
 * An executor's question goes to the agent that made the task first. That agent answers for the
 * user (and the timeline says what it answered and why), sends the question on, or, if it does
 * neither in time, the user sees it. A task the user made, or one its maker executes, asks the user
 * at once. Every test is a real host with scripted models.
 */
import type { BoardTaskDetail, InteractionView } from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const onTask = (request: Request): boolean =>
  request.system.includes("In this task you are");

/** The id the brief gives the maker, read from what it was told. */
const questionIdOf = (request: Request): string =>
  /\(id ([^)]+)\)/.exec(request.transcript.join("\n"))![1]!;

/**
 * Bea executes and asks which colour; Ada made the task. `maker` is what Ada does when the
 * question reaches her.
 */
async function room(
  maker: "answer" | "escalate" | "nothing",
  options: { askTimeoutMs?: number; bySelf?: boolean; on?: boolean } = {},
) {
  const { models, requests } = scriptedModels((request) => {
    if (!onTask(request)) return say("ok");
    if (request.agent === "Ada") {
      if (request.lastRole === "toolResult" || maker === "nothing")
        return say("done");
      const interactionId = questionIdOf(request);
      return maker === "answer"
        ? call("answer_task_question", {
            interactionId,
            text: "teal",
            basis: "The description says teal.",
          })
        : call("escalate_task_question", {
            interactionId,
            reason: "it is the user's taste",
          });
    }
    if (request.lastRole === "toolResult")
      return request.transcript.filter((line) => line.startsWith("toolResult"))
        .length > 1
        ? say("done")
        : request.tools.includes("finish_task")
          ? call("finish_task", { summary: `Got: ${request.last}` })
          : say("ok");
    return call("ask_user", { question: "Which colour?" }, "q-1");
  });
  const w = await world({
    models,
    tasks:
      options.askTimeoutMs === undefined
        ? {}
        : { askTimeoutMs: options.askTimeoutMs },
  });
  w.client.subscribe("inbox");
  // The maker answers only when the user turned it on (`on: false` leaves it as it is made).
  const turn = (autoAnswerAsks: boolean) =>
    w.client.call("tasks", "setSettings", { autoAnswerAsks });
  if (options.on !== false) await turn(true);
  const ada = await w.agent("Ada");
  const bea = await w.agent("Bea");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id, bea.id], "ui");
  await w.watch(group.id);
  const make = (): BoardTaskDetail =>
    w.host.product.board.create(
      {
        title: "Paint it",
        description: "Paint it teal.",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        ...(options.bySelf === true ? {} : { assignee: "Bea" }),
      },
      { kind: "agent", agentId: options.bySelf === true ? bea.id : ada.id },
    );
  return { w, ada, bea, task: make(), make, turn, requests };
}

const rows = (w: World): InteractionView[] =>
  w.client.section<InteractionView[]>("inbox", "list") ?? [];

const timeline = (w: World, taskId: string): string[] =>
  w.host.product.board
    .activity(taskId)
    .filter((entry) => entry.kind === "comment")
    .map((entry) => entry.body ?? "");

const status = (w: World, taskId: string) =>
  w.host.product.board.detail(taskId)?.status;

describe("an executor's question on a task", () => {
  it("goes to the user at once while the setting is off, which is how it starts", async () => {
    const r = await room("answer", { on: false });
    expect(await r.w.client.call("tasks", "setSettings", {})).toEqual({
      settings: {
        archiveAfterDays: 7,
        reactToResults: false,
        autoAnswerAsks: false,
        draftTimeout: { enabled: false, minutes: 10, action: "discard" },
      },
    });
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    expect(
      r.requests.some((request) => request.agent === "Ada" && onTask(request)),
    ).toBe(false);
    expect(timeline(r.w, r.task.id)).toEqual([]);
  });

  it("follows the setting at the next question, without a restart", async () => {
    const r = await room("answer", { on: false });
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    // The user answers the first, so its run is out of the way of the next.
    await r.w.client.call("inbox", "answer", {
      id: rows(r.w).find((row) => row.status === "pending")!.id,
      response: { kind: "freeform", text: "red" },
    });
    await until(() => status(r.w, r.task.id) === "in_review");
    await r.turn(true);
    const second = r.make();
    await until(() => status(r.w, second.id) === "in_review");
    expect(timeline(r.w, second.id).join("\n")).toContain("Answer: teal");
    // Turning it off again ends the routing at the next question.
    expect(rows(r.w).filter((row) => row.status === "pending")).toHaveLength(0);
    await r.turn(false);
    const third = r.make();
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    expect(timeline(r.w, third.id)).toEqual([]);
  });

  it("refuses a setting that is not a boolean", async () => {
    const r = await room("answer", { on: false });
    await expect(
      r.w.client.call("tasks", "setSettings", { autoAnswerAsks: "yes" }),
    ).rejects.toThrow(/true or false/);
  });

  it("is answered by the agent that made the task, and the timeline keeps question, answer and basis", async () => {
    const r = await room("answer");
    await until(() => status(r.w, r.task.id) === "in_review");
    // The user was never asked.
    expect(rows(r.w).filter((row) => row.status === "pending")).toEqual([]);
    expect(rows(r.w).map((row) => row.status)).toEqual(["answered"]);
    const notes = timeline(r.w, r.task.id).join("\n");
    expect(notes).toContain("Question: Which colour?");
    expect(notes).toContain("Answer: teal");
    expect(notes).toContain("Basis: The description says teal.");
    // The executor was told it, and was not told the user did not answer.
    expect(notes).toContain("Got: teal");
    const asked = r.requests.find(
      (request) => request.agent === "Ada" && onTask(request),
    )!;
    expect(asked.tools).toEqual(
      expect.arrayContaining([
        "answer_task_question",
        "escalate_task_question",
      ]),
    );
    expect(asked.transcript.join("\n")).toContain(
      "When in doubt, send it to the user",
    );
    // Only the maker has the two tools.
    const executor = r.requests.find(
      (request) => request.agent === "Bea" && onTask(request),
    )!;
    expect(executor.tools).not.toContain("answer_task_question");
  });

  it("goes to the user's Inbox when the maker sends it on", async () => {
    const r = await room("escalate");
    await until(() =>
      timeline(r.w, r.task.id).some((body) =>
        body.includes("went to the user's Inbox"),
      ),
    );
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    const row = rows(r.w).find((entry) => entry.status === "pending")!;
    expect(row.prompt).toBe("Which colour?");
    await r.w.client.call("inbox", "answer", {
      id: row.id,
      response: { kind: "freeform", text: "red" },
    });
    await until(() => status(r.w, r.task.id) === "in_review");
    expect(timeline(r.w, r.task.id).join("\n")).toContain("Got: red");
  });

  it("goes to the user's Inbox when the maker does not answer in time", async () => {
    const r = await room("nothing", { askTimeoutMs: 200 });
    // Held while the maker has time, and shown once it is up, with a line saying why.
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    expect(
      timeline(r.w, r.task.id).some((body) =>
        body.includes("did not answer in time"),
      ),
    ).toBe(true);
  });

  it("goes to the user at once when the executor made the task itself", async () => {
    const r = await room("answer", { bySelf: true });
    await until(() => rows(r.w).some((row) => row.status === "pending"));
    expect(
      r.requests.some((request) => request.agent === "Ada" && onTask(request)),
    ).toBe(false);
  });
});
