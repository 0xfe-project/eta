/**
 * Task drafts and cards: an agent proposes work as a row of the conversation, the user confirms
 * it, and the same row becomes the task's card and follows the task from then on.
 */
import type {
  BoardTaskDetail,
  MessageView,
  TaskActivityView,
  TaskCardData,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** Ada drafts a task the first time she is spoken to, and says so. */
async function drafted() {
  const { models } = scriptedModels((request) =>
    request.lastRole === "toolResult"
      ? say("Drafted.")
      : call("draft_task", {
          title: "Fix login",
          goal: "Users can sign in again",
          decided: "Keep the existing form",
          acceptance: "The sign-in test passes",
        }),
  );
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id], "login");
  await w.watch(group.id);
  const sent = await w.send(group.id, "we should fix login");
  await w.settled(group.id, sent.replies[0]!.id);
  const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
  return { w, ada, project, group, draft };
}

const confirm = async (
  w: World,
  conversationId: string,
  messageId: string,
  edits?: Record<string, unknown>,
) =>
  (await w.client.call("tasks", "confirmDraft", {
    conversationId,
    messageId,
    ...(edits === undefined ? {} : { edits }),
  })) as { task: BoardTaskDetail; message: MessageView };

const revisionOf = (w: World, id: string): number =>
  w.host.db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM message WHERE id = ?",
    )
    .get(id)!.revision;

describe("a task draft", () => {
  it("is a row of the conversation, composed by the board, and makes no task", async () => {
    const { w, ada, group, draft } = await drafted();
    expect(draft).toMatchObject({
      author: "agent",
      agentId: ada.id,
      status: "done",
      text: "",
      data: { title: "Fix login" },
    });
    const { description } = draft.data as { description: string };
    expect(description).toContain("## 目标\n\nUsers can sign in again");
    expect(description).toContain("## 已决定\n\nKeep the existing form");
    expect(description).toContain("## 验收标准\n\nThe sign-in test passes");
    // Where it came from: the conversation, and the rows from the message that woke Ada on.
    expect(description).toContain("来源：对话《login》第 1–2 条。");
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({
      n: 0,
    });
    // It sits after the reply that made it, and is read as the agent's.
    const rows = w.rows(group.id);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "task_draft",
    ]);
  });

  it("becomes a task and a card on confirm, and keeps its place in the timeline", async () => {
    const { w, group, draft } = await drafted();
    const { task, message } = await confirm(w, group.id, draft.id, {
      title: "  Fix the login form ",
      status: "in_review",
      assignee: "user",
    });
    expect(task).toMatchObject({
      number: 1,
      title: "Fix the login form",
      status: "in_review",
      assignee: "user",
      conversationId: group.id,
      createdBy: { kind: "user", agentId: null },
      // Not edited, so it is the draft's.
      description: (draft.data as { description: string }).description,
    });
    expect(message).toMatchObject({
      id: draft.id,
      seq: draft.seq,
      kind: "task_card",
      author: "agent",
      revision: draft.revision + 1,
    });
    expect(message.data).toEqual({
      taskId: task.id,
      number: 1,
      title: "Fix the login form",
      status: "in_review",
      assignee: "user",
      conversationId: group.id,
      comments: 0,
      summary: "",
      artifacts: [],
    });
    // The client's timeline has the card where the draft was.
    await until(() => w.row(group.id, draft.id)?.kind === "task_card");
    expect(w.rows(group.id).filter((row) => row.id === draft.id)).toHaveLength(
      1,
    );

    w.client.subscribe(`tasks.${task.id}`);
    await until(
      () => w.client.section(`tasks.${task.id}`, "activity") !== undefined,
    );
    const created = w.client.section<TaskActivityView[]>(
      `tasks.${task.id}`,
      "activity",
    )![0]!;
    expect(created).toMatchObject({
      kind: "created",
      actor: { kind: "user" },
      data: { status: "in_review", assignee: "user", draftId: draft.id },
    });
  });

  it("confirms once: a second confirm, edited or not, is the same task", async () => {
    const { w, group, draft } = await drafted();
    const first = await confirm(w, group.id, draft.id);
    const revision = revisionOf(w, draft.id);
    expect(first.task).toMatchObject({ status: "todo", assignee: "none" });

    const second = await confirm(w, group.id, draft.id, { title: "Other" });
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.title).toBe("Fix login");
    expect(second.message.revision).toBe(revision);
    expect(revisionOf(w, draft.id)).toBe(revision);
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({
      n: 1,
    });
    expect(
      w.host.db.query("SELECT COUNT(*) AS n FROM task_activity").get(),
    ).toEqual({ n: 1 });
  });

  it("is refused when the row is not a draft of that conversation", async () => {
    const { w, ada, project, group, draft } = await drafted();
    const other = await w.group(project.id, [ada.id], "elsewhere");
    const user = w.rows(group.id).find((row) => row.author === "user")!;

    await expect(confirm(w, group.id, user.id)).rejects.toThrow(
      /no such task draft/,
    );
    await expect(confirm(w, group.id, "nope")).rejects.toThrow(
      /no such task draft/,
    );
    // The draft is in `group`; naming another conversation does not find it.
    await expect(confirm(w, other.id, draft.id)).rejects.toThrow(
      /no such task draft/,
    );
    await expect(
      confirm(w, group.id, draft.id, { status: "finished" }),
    ).rejects.toThrow(/status must be one of/);
    // None of those turned it into anything.
    expect(w.rows(group.id).find((row) => row.id === draft.id)?.kind).toBe(
      "task_draft",
    );
  });
});

describe("a task card", () => {
  const card = (w: World, conversationId: string, id: string) =>
    w.row(conversationId, id)!.data as unknown as TaskCardData;

  it("says what the task says, and moves its revision when the task changes", async () => {
    const { w, ada, project, group, draft } = await drafted();
    const { task } = await confirm(w, group.id, draft.id);
    const other = await w.group(project.id, [ada.id], "elsewhere");
    let revision = revisionOf(w, draft.id);

    await w.client.call("tasks", "update", {
      taskId: task.id,
      status: "in_progress",
      title: "Fix the login form",
    });
    await until(() => card(w, group.id, draft.id).status === "in_progress");
    expect(card(w, group.id, draft.id).title).toBe("Fix the login form");
    expect(revisionOf(w, draft.id)).toBeGreaterThan(revision);
    revision = revisionOf(w, draft.id);

    await w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "first look",
    });
    await w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "found the cause",
    });
    await until(() => card(w, group.id, draft.id).comments === 2);
    expect(card(w, group.id, draft.id).summary).toBe("found the cause");
    revision = revisionOf(w, draft.id);

    // A change that changes nothing does not touch the card.
    await w.client.call("tasks", "update", {
      taskId: task.id,
      status: "in_progress",
    });
    expect(revisionOf(w, draft.id)).toBe(revision);

    // The card follows the task's link, and stays where it was proposed.
    await w.client.call("tasks", "link", {
      taskId: task.id,
      conversationId: other.id,
    });
    await until(() => card(w, group.id, draft.id).conversationId === other.id);
    expect(w.row(group.id, draft.id)?.conversationId).toBe(group.id);
    expect(revisionOf(w, draft.id)).toBeGreaterThan(revision);
  });

  it("stays behind when its task is deleted, and says so", async () => {
    const { w, group, draft } = await drafted();
    const { task } = await confirm(w, group.id, draft.id, { status: "done" });
    await w.client.call("tasks", "delete", { taskId: task.id });

    await until(() => card(w, group.id, draft.id).deleted === true);
    expect(w.row(group.id, draft.id)).toMatchObject({
      kind: "task_card",
      data: { number: 1, title: "Fix login", status: "done", deleted: true },
    });
    // There is nothing left to confirm into.
    await expect(confirm(w, group.id, draft.id)).rejects.toThrow(
      /task was deleted/,
    );
  });

  it("is made by a confirmed draft only: creating or linking a task puts no card anywhere", async () => {
    const { w, group } = await drafted();
    const made = (await w.client.call("tasks", "create", {
      title: "By hand",
      conversationId: group.id,
    })) as { task: BoardTaskDetail };
    await w.client.call("tasks", "comment", {
      taskId: made.task.id,
      body: "hello",
    });
    expect(w.rows(group.id).map((row) => row.kind)).toEqual([
      "message",
      "message",
      "task_draft",
    ]);
  });
});
