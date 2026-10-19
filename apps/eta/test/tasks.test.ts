/**
 * The task board through a real socket: the `tasks` target and the target each task has, the
 * numbers, the timeline of changes, and what survives a restart. Runs are off here (they have
 * their own tests): a task is made the way an agent's tool makes it, and nothing starts.
 */
import type {
  BoardTaskDetail,
  BoardTaskView,
  TaskActivityView,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { TASK_ACTIONS } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

/** The board as this client holds it. */
const board = (w: World): BoardTaskView[] =>
  w.client.section<BoardTaskView[]>("tasks", "list") ?? [];

const OFF = { tasks: { runs: false } } as const;

/** What the first agent of a world needs to make a task: an agent in a conversation. */
const seeded = new WeakMap<
  World,
  { agentId: string; conversationId: string }
>();

async function seed(w: World) {
  let found = seeded.get(w);
  if (found === undefined) {
    const agent = await w.agent("Ada");
    const project = await w.project({ stewardId: agent.id });
    const group = await w.group(project.id, [agent.id]);
    found = { agentId: agent.id, conversationId: group.id };
    seeded.set(w, found);
  }
  return found;
}

/** A task as an agent's tool makes it, resting in the backlog. */
async function create(
  w: World,
  args: { title: string; description?: string; status?: string },
): Promise<BoardTaskDetail> {
  const { agentId, conversationId } = await seed(w);
  return w.host.product.board.create(
    { status: "backlog", ...args, conversationId, workspace: "local" },
    { kind: "agent", agentId },
  );
}

async function activityOf(
  w: World,
  taskId: string,
): Promise<TaskActivityView[]> {
  const target = `tasks.${taskId}`;
  w.client.subscribe(target);
  await until(() => w.client.section(target, "activity") !== undefined);
  return w.client.section<TaskActivityView[]>(target, "activity")!;
}

describe("the tasks target", () => {
  it("offers its actions and puts the board in hello", async () => {
    const w = await world(OFF);
    const hello = await w.client.hello();
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(TASK_ACTIONS.map((action) => `tasks.${action}`)),
    );
    expect(hello.state.tasks?.sections.list).toEqual([]);
    expect(hello.mounted.map((plugin) => plugin.name)).toContain("tasks");
    // Users do not make tasks: there is no way to, and an agent's tool is the only one.
    expect(hello.ops.map((op) => op.name)).not.toContain("tasks.create");
    await expect(
      w.client.call("tasks", "create", { title: "By hand" }),
    ).rejects.toThrow();
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({
      n: 0,
    });
  });

  it("refuses a task made by anybody but an agent", async () => {
    const w = await world(OFF);
    const { conversationId } = await seed(w);
    expect(() =>
      w.host.product.board.create(
        { title: "x", conversationId, workspace: "local" },
        { kind: "user", agentId: null },
      ),
    ).toThrow(/only an agent makes a task/);
  });

  it("makes a task, changes it field by field, and keeps a timeline of what happened", async () => {
    const w = await world(OFF);
    w.client.subscribe("tasks");

    const made = await create(w, {
      title: "  Ship the release  ",
      description: "Cut 1.0",
      status: "todo",
    });
    const { agentId, conversationId } = await seed(w);
    expect(made).toMatchObject({
      number: 1,
      title: "Ship the release",
      description: "Cut 1.0",
      status: "todo",
      // The agent that made it is its executor, working in the conversation's project.
      createdBy: { kind: "agent", agentId },
      conversationId,
      originConversationId: conversationId,
      runStatus: null,
      runs: [],
      workspace: { mode: "local", path: null, branch: null },
      comments: 0,
      artifacts: [],
    });
    await until(() => board(w).length === 1);
    expect(board(w)[0]).toMatchObject({ id: made.id, number: 1 });
    // The board's list leaves out what only the task's own page shows.
    expect(board(w)[0]).not.toHaveProperty("description");

    const { task: moved } = (await w.client.call("tasks", "update", {
      taskId: made.id,
      title: "Ship 1.0",
      status: "in_progress",
    })) as { task: BoardTaskDetail };
    expect(moved).toMatchObject({
      title: "Ship 1.0",
      status: "in_progress",
    });
    expect(moved.updatedAt).toBeGreaterThanOrEqual(made.updatedAt);

    // Nothing changes, nothing is written: not an entry, and the task is not touched.
    const { task: same } = (await w.client.call("tasks", "update", {
      taskId: made.id,
      status: "in_progress",
    })) as { task: BoardTaskDetail };
    expect(same.updatedAt).toBe(moved.updatedAt);

    const commented = (await w.client.call("tasks", "comment", {
      taskId: made.id,
      body: "Blocked on the signing key",
    })) as { task: BoardTaskDetail; activity: TaskActivityView };
    expect(commented.task.comments).toBe(1);
    expect(commented.activity).toMatchObject({
      kind: "comment",
      body: "Blocked on the signing key",
      actor: { kind: "user", agentId: null },
    });
    await until(() => board(w)[0]?.comments === 1);

    // One entry per field that changed, in the order they happened.
    const activity = await activityOf(w, made.id);
    expect(activity.map((entry) => entry.kind)).toEqual([
      "created",
      "title",
      "status",
      "comment",
    ]);
    expect(activity[0]!.data).toMatchObject({ status: "todo" });
    expect(activity[1]!.data).toEqual({
      from: "Ship the release",
      to: "Ship 1.0",
    });
    expect(activity[2]!.data).toEqual({ from: "todo", to: "in_progress" });

    // The task's own target carries the detail and the activity, and follows a change.
    const target = `tasks.${made.id}`;
    expect(w.client.section<BoardTaskDetail>(target, "task")).toMatchObject({
      description: "Cut 1.0",
      comments: 1,
    });
    await w.client.call("tasks", "update", {
      taskId: made.id,
      status: "done",
    });
    await until(
      () =>
        w.client.section<BoardTaskDetail>(target, "task")?.status === "done",
    );
    await until(
      () =>
        w.client.section<TaskActivityView[]>(target, "activity")!.length === 5,
    );
  });

  it("adds a comment once however often the same client id is sent", async () => {
    const w = await world(OFF);
    const made = await create(w, { title: "Retry" });
    const send = (body: string, clientId?: string) =>
      w.client.call("tasks", "comment", {
        taskId: made.id,
        body,
        ...(clientId === undefined ? {} : { clientId }),
      }) as Promise<{ task: BoardTaskDetail; activity: TaskActivityView }>;

    const first = await send("Ping", "c1");
    const retry = await send("Ping", "c1");
    expect(retry.activity.id).toBe(first.activity.id);
    expect(retry.task.comments).toBe(1);

    // Another id, or none, is another comment.
    expect((await send("Ping", "c2")).task.comments).toBe(2);
    expect((await send("Ping")).task.comments).toBe(3);
    expect((await send("Ping")).task.comments).toBe(4);
    const comments = (await activityOf(w, made.id)).filter(
      (entry) => entry.kind === "comment",
    );
    expect(comments).toHaveLength(4);
  });

  it("refuses what is not a task, a status or a title, and says which", async () => {
    const w = await world(OFF);
    const made = await create(w, { title: "Real" });
    await expect(
      w.client.call("tasks", "update", { taskId: made.id, status: "finished" }),
    ).rejects.toThrow(/status must be one of/);
    await expect(
      w.client.call("tasks", "update", { taskId: made.id, title: " " }),
    ).rejects.toThrow(/needs a title/);
    await expect(
      w.client.call("tasks", "update", { taskId: "nope", title: "x" }),
    ).rejects.toThrow(/no such task/);
    await expect(
      w.client.call("tasks", "comment", { taskId: made.id, body: " " }),
    ).rejects.toThrow(/needs body/);
    await expect(
      w.client.call("tasks", "delete", { taskId: "nope" }),
    ).rejects.toThrow(/no such task/);
    expect(() =>
      w.host.product.board.create(
        { title: "x", conversationId: "nowhere", workspace: "local" },
        { kind: "agent", agentId: "ada" },
      ),
    ).toThrow(/no such conversation/);
    // None of that left a task behind.
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({
      n: 1,
    });
  });

  it("numbers tasks from 1 and never gives a number out twice, not even after a delete", async () => {
    const w = await world(OFF);
    const numbers: number[] = [];
    for (const title of ["a", "b", "c"])
      numbers.push((await create(w, { title })).number);
    expect(numbers).toEqual([1, 2, 3]);

    const newest = w.host.db
      .query<{ id: string }, []>("SELECT id FROM task WHERE number = 3")
      .get()!;
    await w.client.call("tasks", "delete", { taskId: newest.id });
    // The newest is gone, and its number goes with it: the next task is #4, not #3 again.
    expect((await create(w, { title: "d" })).number).toBe(4);
  });

  it("links a task to a conversation and takes the link away", async () => {
    const w = await world(OFF);
    const { conversationId } = await seed(w);
    const project = await w.project();
    const other = await w.group(project.id, [(await w.agent("Bob")).id]);
    const group = other;
    const made = await create(w, { title: "Linked" });

    const { task: linked } = (await w.client.call("tasks", "link", {
      taskId: made.id,
      conversationId: group.id,
    })) as { task: BoardTaskDetail };
    expect(linked.conversationId).toBe(group.id);
    const { task: unlinked } = (await w.client.call("tasks", "link", {
      taskId: made.id,
      conversationId: null,
    })) as { task: BoardTaskDetail };
    expect(unlinked.conversationId).toBeNull();

    const entries = (await activityOf(w, made.id)).filter(
      (entry) => entry.kind === "conversation",
    );
    expect(entries.map((entry) => entry.data)).toEqual([
      { from: conversationId, to: group.id },
      { from: group.id, to: null },
    ]);
    // Where it came from stays, wherever it is discussed now.
    expect(
      w.client.section<BoardTaskDetail>(`tasks.${made.id}`, "task")
        ?.originConversationId,
    ).toBe(conversationId);
    await expect(
      w.client.call("tasks", "link", { taskId: made.id }),
    ).rejects.toThrow(/needs conversationId/);
    await expect(
      w.client.call("tasks", "link", { taskId: made.id, conversationId: "x" }),
    ).rejects.toThrow(/no such conversation/);
  });

  it("takes a deleted task off the board and its target off the wire", async () => {
    const w = await world(OFF);
    w.client.subscribe("tasks");
    const made = await create(w, { title: "Short lived" });
    const target = `tasks.${made.id}`;
    expect(w.host.server.wire.targets().map((t) => t.name)).toContain(target);

    await w.client.call("tasks", "delete", { taskId: made.id });
    await until(() => board(w).length === 0);
    expect(w.host.server.wire.targets().map((t) => t.name)).not.toContain(
      target,
    );
    // Its timeline went with it.
    expect(
      w.host.db.query("SELECT COUNT(*) AS n FROM task_activity").get(),
    ).toEqual({ n: 0 });
  });

  it("answers target:missing to a subscription for a task that is not there, and to the page of a task deleted under it", async () => {
    const w = await world(OFF);
    const missing = (target: string) =>
      w.client.frames.filter(
        (frame) =>
          frame.type === "event" &&
          frame.target === target &&
          frame.name === "target:missing",
      ).length;
    w.client.subscribe("tasks.nope");
    await until(() => missing("tasks.nope") === 1);

    const made = await create(w, { title: "Short lived" });
    const target = `tasks.${made.id}`;
    w.client.subscribe(target);
    await until(() => w.client.section(target, "task") !== undefined);
    expect(missing(target)).toBe(0);
    await w.client.call("tasks", "delete", { taskId: made.id });
    await until(() => missing(target) === 1);
  });

  it("orders the board by what was touched last", async () => {
    const w = await world(OFF);
    w.client.subscribe("tasks");
    const first = await create(w, { title: "first" });
    await create(w, { title: "second" });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await w.client.call("tasks", "comment", { taskId: first.id, body: "ping" });
    await until(() => board(w)[0]?.id === first.id);
    expect(board(w).map((task) => task.title)).toEqual(["first", "second"]);
  });

  it("is the same board after a restart, and every task has its target again", async () => {
    const dataDir = await tempDir();
    const first = await world({ dataDir, ...OFF });
    const made = await create(first, { title: "Kept" });
    await first.client.call("tasks", "comment", {
      taskId: made.id,
      body: "still here",
    });
    await first.host.close();

    const second = await testHost({ dataDir, ...OFF });
    const client = await connect(`ws://127.0.0.1:${second.port}/ws`);
    const hello = await client.hello();
    expect(hello.state.tasks?.sections.list).toMatchObject([
      { id: made.id, number: 1, title: "Kept", comments: 1 },
    ]);
    client.subscribe(`tasks.${made.id}`);
    await until(
      () => client.section(`tasks.${made.id}`, "activity") !== undefined,
    );
    expect(
      client
        .section<TaskActivityView[]>(`tasks.${made.id}`, "activity")!
        .map((entry) => entry.kind),
    ).toEqual(["created", "comment"]);
    client.close();
  });
});
