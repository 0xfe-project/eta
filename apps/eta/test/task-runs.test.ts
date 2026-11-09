/**
 * Tasks run. The agent that made a task executes it, in a fresh session of its own (its persona,
 * none of its conversation), in a worktree or in the project directory, and reports with
 * `finish_task`: the task moves to review and the result is said in the conversation it came from.
 * Every test is a real host with scripted models; the executor is the scripted agent.
 */
import type {
  BoardTaskDetail,
  MachineView,
  MessageView,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DaemonLink, DaemonNode } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import { loadMigrations, statementsOf } from "../src/db";
import { streamActivityCoversPoll } from "../src/tasks/runner";
import { connect, until } from "./support/client";
import { machineView } from "./support/daemon";
import { tempDir, testHost } from "./support/host";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

/** A request of a task's executor, as opposed to one of a conversation's members. */
const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

/** Which task an executor's request is about, from its briefing. */
const numberOf = (request: Request): number =>
  Number(/task #(\d+)/.exec(request.transcript[0] ?? "")?.[1]);

/** An executor that reports at once, and a conversation member that has nothing to say. */
const finishes =
  (summary = "All done.") =>
  (request: Request) =>
    !isRun(request)
      ? say("ok")
      : request.lastRole === "toolResult"
        ? say("finished")
        : call("finish_task", { summary });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A directory that is a git repository with one commit. */
async function repo(): Promise<string> {
  const dir = await tempDir("eta-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

async function room(
  respond: (
    request: Request,
  ) =>
    | ReturnType<typeof say>
    | typeof HANG
    | Promise<ReturnType<typeof say> | typeof HANG>,
  options: { dir?: string; instructions?: string } = {},
) {
  const { models, requests } = scriptedModels(respond);
  const w = await world({ models });
  const ada = await w.agent("Ada", {
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
  });
  const project = await w.project({
    ...(options.dir === undefined ? {} : { path: options.dir }),
    stewardId: ada.id,
  });
  const group = await w.group(project.id, [ada.id], "login");
  await w.watch(group.id);
  return { w, ada, project, group, requests };
}
type Room = Awaited<ReturnType<typeof room>>;

/** A task as Ada's `create_task` makes it. */
const make = (
  r: Pick<Room, "w" | "ada" | "group">,
  title: string,
  workspace: "local" | "worktree" = "local",
  extra: { base?: string; assignee?: string } = {},
): BoardTaskDetail =>
  r.w.host.product.board.create(
    {
      title,
      description: `Do ${title}`,
      status: "todo",
      conversationId: r.group.id,
      workspace,
      ...extra,
    },
    { kind: "agent", agentId: r.ada.id },
  );

const runsOf = (w: World, taskId: string): TaskRunView[] =>
  w.host.db
    .query<
      {
        id: string;
        status: TaskRunView["status"];
        queue_reason: TaskRunView["queueReason"];
        session_id: string | null;
        continues_run_id: string | null;
        workspace: string | null;
        error: string | null;
      },
      [string]
    >("SELECT * FROM task_run WHERE task_id = ? ORDER BY created_at, rowid")
    .all(taskId)
    .map((row) => ({
      id: row.id,
      status: row.status,
      queueReason: row.queue_reason,
      sessionId: row.session_id,
      continuesRunId: row.continues_run_id,
      workspace: row.workspace,
      error: row.error,
    })) as TaskRunView[];

/** The machine the host itself is, as the settings page lists it. */
const primaryOf = (w: World): MachineView =>
  w.client
    .section<MachineView[]>("machines", "list")!
    .find((machine) => machine.kind === "primary")!;

const taskOf = (w: World, id: string): BoardTaskDetail => {
  const task = w.host.product.board.detail(id);
  if (task === undefined) throw new Error("no such task");
  return task;
};

/** In review, and the run that put it there has ended too (it is a turn later than the status). */
const reviewed = (w: World, id: string): boolean =>
  taskOf(w, id).status === "in_review" &&
  runsOf(w, id).every(
    (run) => !["queued", "starting", "running"].includes(run.status),
  );

const activityKinds = (w: World, id: string): string[] =>
  w.host.product.board
    .activity(id)
    .map((entry: TaskActivityView) => entry.kind);

const runStatuses = (w: World, id: string) =>
  runsOf(w, id).map((run) => run.status);

/** A host, an agent, a group, and a daemon's machine the project lives on. */
async function remote(respond: Parameters<typeof room>[0]) {
  const { models, requests } = scriptedModels(respond);
  const r = await remoteWorld({ models });
  const { agents, group } = await r.agents("Ada");
  return { r, requests, ada: agents[0]!, group };
}

describe("a task run", () => {
  it("falls back to sequence polling when streamed activity goes silent", () => {
    const now = Date.now();
    expect(streamActivityCoversPoll(0, now)).toBe(false);
    expect(streamActivityCoversPoll(now - 19_999, now)).toBe(true);
    expect(streamActivityCoversPoll(now - 20_000, now)).toBe(false);
  });

  it("starts when the user confirms an agent's draft, in a fresh session with the agent's persona and none of its conversation", async () => {
    const { models, requests } = scriptedModels((request) => {
      if (isRun(request))
        return request.lastRole === "toolResult"
          ? say("finished")
          : call("finish_task", { summary: "Login works again, on a branch." });
      return request.lastRole === "toolResult"
        ? say("Drafted.")
        : call("draft_task", {
            title: "Fix login",
            goal: "Users can sign in again",
            acceptance: "The sign-in test passes",
          });
    });
    const w = await world({ models });
    const ada = await w.agent("Ada", { instructions: "Answer in one line." });
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "login");
    await w.watch(group.id);
    const sent = await w.send(group.id, "we should fix login");
    await w.settled(group.id, sent.replies[0]!.id);
    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    // The draft is a proposal: nothing runs until the user says so.
    expect(draft.data).toMatchObject({ workspace: "local" });
    expect(requests.filter(isRun)).toHaveLength(0);
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task_run").get()).toEqual(
      { n: 0 },
    );

    const { task } = (await w.client.call("tasks", "confirmDraft", {
      conversationId: group.id,
      messageId: draft.id,
    })) as { task: BoardTaskDetail };
    await until(() => reviewed(w, task.id));

    // One fresh session, which is the run's.
    const [run] = runsOf(w, task.id);
    expect(run).toMatchObject({ status: "completed" });
    const members = w.client.section<{ sessionId: string | null }[]>(
      `conversations.${group.id}`,
      "members",
    )!;
    expect(run!.sessionId).not.toBeNull();
    expect(run!.sessionId).not.toBe(members[0]!.sessionId);

    // It is Ada, with her instructions and her tools, told the task and nothing of the talk.
    const [first] = requests.filter(isRun);
    expect(first!.agent).toBe("Ada");
    expect(first!.system).toContain("Answer in one line.");
    expect(first!.tools).toEqual(
      expect.arrayContaining([
        "publish_artifact",
        "list_tasks",
        "get_task",
        "comment_task",
        "finish_task",
      ]),
    );
    expect(first!.tools).not.toContain("draft_task");
    expect(first!.tools).not.toContain("mention");
    const briefing = first!.transcript.join("\n");
    expect(briefing).toContain("task #1");
    expect(briefing).toContain("Users can sign in again");
    expect(briefing).toContain("The sign-in test passes");
    expect(briefing).toContain('"login"');
    expect(briefing).not.toContain("we should fix login");

    // The executor moved it to review and said so where the task came from, as Ada.
    expect(taskOf(w, task.id)).toMatchObject({
      status: "in_review",
      runStatus: "completed",
      createdBy: { kind: "agent", agentId: ada.id },
      originConversationId: group.id,
    });
    expect(activityKinds(w, task.id)).toEqual(
      expect.arrayContaining([
        "created",
        "run_queued",
        "run_started",
        "comment",
        "run_completed",
      ]),
    );
    const result = w
      .rows(group.id)
      .find((row: MessageView) => row.data.event === "task_result")!;
    expect(result).toMatchObject({ author: "agent", agentId: ada.id });
    expect(result.text).toContain("#1 Fix login");
    expect(result.text).toContain("Login works again, on a branch.");
  });

  it("is run by the agent it was assigned to, which is not always the agent that made it", async () => {
    const r = await room(finishes());
    const bola = await r.w.agent("Bola");
    const task = make(r, "For Bola", "local", { assignee: bola.id });
    await until(() => reviewed(r.w, task.id));
    // The executor's brief is Bola's: the assignee runs it, though Ada made it.
    const runs = r.requests.filter(isRun);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.system).toContain("In this task you are Bola");
    expect(runs[0]!.system).not.toContain("In this task you are Ada");
    expect(taskOf(r.w, task.id).createdBy).toMatchObject({
      kind: "agent",
      agentId: r.ada.id,
    });
    expect(taskOf(r.w, task.id).assigneeAgentId).toBe(bola.id);
  });

  it("resolves an assignee named by name to its id, and refuses one nobody is", async () => {
    const r = await room(finishes());
    const bola = await r.w.agent("Bola");
    const task = make(r, "For Bola by name", "local", { assignee: "Bola" });
    expect(task.assigneeAgentId).toBe(bola.id);
    await until(() => reviewed(r.w, task.id));
    expect(() =>
      make(r, "For nobody", "local", { assignee: "Nobody" }),
    ).toThrow(/no agent is "Nobody".*Ada \(.*Bola \(/);
    expect(r.w.host.product.board.list().map((t) => t.title)).not.toContain(
      "For nobody",
    );
  });

  it("runs a task whose stored assignee was a name once the migration has made it an id", async () => {
    const r = await room(finishes());
    const bola = await r.w.agent("Bola");
    const task = make(r, "For Bola", "local", { assignee: bola.id });
    await until(() => reviewed(r.w, task.id));
    // A row written before names were resolved: the queue cannot find `Bola` by id.
    r.w.host.db
      .query("UPDATE task SET assignee_agent = 'Bola' WHERE id = ?")
      .run(task.id);
    await expect(
      r.w.client.call("tasks", "rerun", { taskId: task.id }),
    ).rejects.toThrow(/assigned to execute this task \(Bola\)/);
    const migration = loadMigrations().find(
      (m) => m.id === "0045-normalize-assignee-names",
    )!;
    for (const statement of statementsOf(migration.sql))
      r.w.host.db.exec(statement);
    expect(taskOf(r.w, task.id).assigneeAgentId).toBe(bola.id);
    await r.w.client.call("tasks", "rerun", { taskId: task.id });
    await until(
      () => runStatuses(r.w, task.id).join() === "completed,completed",
    );
  });

  it("says the assignee is missing, not the maker, when the assignee is not registered", async () => {
    const r = await room(finishes());
    const bola = await r.w.agent("Bola");
    const task = make(r, "For Bola", "local", { assignee: bola.id });
    await until(() => reviewed(r.w, task.id));
    r.w.host.db.query("DELETE FROM agent WHERE id = ?").run(bola.id);
    let said = "";
    try {
      await r.w.client.call("tasks", "rerun", { taskId: task.id });
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toContain(`assigned to execute this task (${bola.id})`);
    expect(said).toContain("not the agent that made the task");
    expect(said).not.toContain("the agent that made this task is gone");
  });

  it("says the maker is missing when the maker executes and is not registered", async () => {
    const r = await room(finishes());
    const task = make(r, "Ada's own", "local");
    await until(() => reviewed(r.w, task.id));
    const adaId = r.ada.id;
    r.w.host.db.query("DELETE FROM agent WHERE id = ?").run(adaId);
    let said = "";
    try {
      await r.w.client.call("tasks", "rerun", { taskId: task.id });
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toContain(
      `the agent that made this task and was to execute it (${adaId}) is not registered`,
    );
  });

  it("is only ever made by an agent: the user has no way to create a task", async () => {
    const r = await room(finishes());
    await expect(
      r.w.client.call("tasks", "create", { title: "mine" }),
    ).rejects.toThrow();
    expect(() =>
      r.w.host.product.board.create(
        { title: "mine", conversationId: r.group.id, workspace: "local" },
        { kind: "user", agentId: null },
      ),
    ).toThrow(/only an agent/);
  });

  it("works in the project directory in local mode, where a project that is not a repository can only work", async () => {
    const r = await room(finishes());
    const task = make(r, "Tidy up", "local");
    await until(() => reviewed(r.w, task.id));
    const [run] = runsOf(r.w, task.id);
    expect(await realpath(run!.workspace!)).toBe(
      await realpath(r.project.path),
    );
    expect(taskOf(r.w, task.id).workspace).toEqual({
      mode: "local",
      base: null,
      path: null,
      branch: null,
    });
  });

  it("works in a worktree of its own on eta/task-<n> in worktree mode, and leaves it after the run", async () => {
    const dir = await repo();
    const r = await room(finishes("Committed on the branch."), { dir });
    const task = make(r, "Add a file", "worktree");
    await until(() => reviewed(r.w, task.id));

    const detail = taskOf(r.w, task.id);
    const where = join(r.w.host.dataDir, "worktrees", r.project.id, "task-1");
    expect(detail.workspace).toMatchObject({
      mode: "worktree",
      path: where,
      branch: "eta/task-1",
    });
    expect(runsOf(r.w, task.id)[0]!.workspace).toBe(where);
    // The branch is the project's, the worktree is outside its directory, and both stay.
    expect(git(dir, "branch", "--list", "eta/task-1")).toContain("eta/task-1");
    expect(git(dir, "worktree", "list")).toContain(where);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(where)).toBe(true);
    expect(git(where, "rev-parse", "--abbrev-ref", "HEAD")).toBe("eta/task-1");

    // A rerun finds its way back to the same files.
    await r.w.client.call("tasks", "rerun", { taskId: task.id });
    await until(
      () => runStatuses(r.w, task.id).join() === "completed,completed",
    );
    expect(runsOf(r.w, task.id)[1]!.workspace).toBe(where);
  });

  it("starts a worktree at the branch the task names, not the checkout's HEAD", async () => {
    const dir = await repo();
    // A second line the checkout is not on: the task's worktree must start there.
    git(dir, "switch", "-q", "-c", "side-line");
    git(dir, "commit", "-q", "--allow-empty", "-m", "side work");
    const side = git(dir, "rev-parse", "HEAD");
    git(dir, "switch", "-q", "main");
    const r = await room(finishes(), { dir });
    const task = make(r, "On the side", "worktree", { base: "side-line" });
    await until(() => reviewed(r.w, task.id));
    expect(taskOf(r.w, task.id).workspace.base).toBe("side-line");
    const where = join(r.w.host.dataDir, "worktrees", r.project.id, "task-1");
    expect(git(where, "rev-parse", "HEAD")).toBe(side);
    expect(git(dir, "rev-parse", "main")).not.toBe(side);
  });

  it("resolves a `#number` base to that task's branch, so one task can build on another", async () => {
    const dir = await repo();
    const r = await room(finishes(), { dir });
    const first = make(r, "First", "worktree", { base: "main" });
    await until(() => reviewed(r.w, first.id));
    const second = make(r, "Second", "worktree", { base: `#${first.number}` });
    expect(taskOf(r.w, second.id).workspace.base).toBe(
      `eta/task-${first.number}`,
    );
    await until(() => reviewed(r.w, second.id));
    const where = join(
      r.w.host.dataDir,
      "worktrees",
      r.project.id,
      `task-${second.number}`,
    );
    expect(git(where, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      `eta/task-${second.number}`,
    );
    expect(git(where, "merge-base", `eta/task-${first.number}`, "HEAD")).toBe(
      git(where, `rev-parse`, `eta/task-${first.number}`),
    );
  });

  it("is told, when the agent proposes the task, that a worktree needs a repository; and picks the workspace by default", async () => {
    /** Ada drafts a task asking for each workspace in turn; what she hears and what she drafted. */
    async function drafting(
      dir: string | undefined,
      asked: (string | undefined)[],
    ) {
      let n = 0;
      const heard: string[] = [];
      const r = await room(
        (request) => {
          if (isRun(request)) return say("ok");
          if (request.lastRole === "toolResult") {
            heard.push(request.last);
            return say("ok");
          }
          const workspace = asked[n++];
          return call("draft_task", {
            title: `T${n}`,
            goal: "g",
            acceptance: "a",
            ...(workspace === undefined ? {} : { workspace }),
          });
        },
        dir === undefined ? {} : { dir },
      );
      for (let i = 0; i < asked.length; i++) {
        const sent = await r.w.send(r.group.id, `go ${i}`);
        await r.w.settled(r.group.id, sent.replies[0]!.id);
      }
      const drafts = r.w
        .rows(r.group.id)
        .filter((row) => row.kind === "task_draft")
        .map((row) => (row.data as { workspace: string }).workspace);
      return { heard, drafts };
    }
    const plain = await drafting(undefined, ["worktree", undefined]);
    expect(plain.heard[0]).toMatch(/not a git repository/);
    expect(plain.drafts).toEqual(["local"]);
    const repository = await drafting(await repo(), [undefined, "local"]);
    expect(repository.drafts).toEqual(["worktree", "local"]);
  });
});

describe("the queue", () => {
  it("runs at most the machine's limit at once, and the rest wait with the reason", async () => {
    const gates = new Map([1, 2, 3].map((n) => [n, gate()]));
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (request.lastRole === "toolResult") return say("finished");
      await gates.get(numberOf(request))!.opened;
      return call("finish_task", { summary: "ok" });
    });
    const machine = primaryOf(r.w);
    expect(machine.maxActiveRuns).toBe(2);

    const [a, b, c] = [make(r, "A"), make(r, "B"), make(r, "C")];
    await until(
      () =>
        runStatuses(r.w, a.id)[0] === "running" &&
        runStatuses(r.w, b.id)[0] === "running",
    );
    expect(runsOf(r.w, c.id)[0]).toMatchObject({
      status: "queued",
      queueReason: "machine_full",
    });
    // The board says so: the third is queued, the first two are working.
    expect(taskOf(r.w, c.id).runStatus).toBe("queued");

    // A slot frees when a run ends, and the waiting run takes it.
    gates.get(1)!.open();
    await until(() => runStatuses(r.w, a.id)[0] === "completed");
    await until(() => runStatuses(r.w, c.id)[0] === "running");
    expect(runsOf(r.w, c.id)[0]!.queueReason).toBeNull();
    gates.get(2)!.open();
    gates.get(3)!.open();
    await until(() => reviewed(r.w, c.id));
  });

  it("follows the limit when the user changes it", async () => {
    const hold = gate();
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (request.lastRole === "toolResult") return say("finished");
      await hold.opened;
      return call("finish_task", { summary: "ok" });
    });
    const machine = primaryOf(r.w);
    await r.w.client.call("machines", "setMaxActiveRuns", {
      machineId: machine.id,
      maxActiveRuns: 1,
    });
    const [a, b] = [make(r, "A"), make(r, "B")];
    await until(() => runStatuses(r.w, a.id)[0] === "running");
    expect(runsOf(r.w, b.id)[0]).toMatchObject({
      status: "queued",
      queueReason: "machine_full",
    });
    await r.w.client.call("machines", "setMaxActiveRuns", {
      machineId: machine.id,
      maxActiveRuns: 2,
    });
    await until(() => runStatuses(r.w, b.id)[0] === "running");
    await expect(
      r.w.client.call("machines", "setMaxActiveRuns", {
        machineId: machine.id,
        maxActiveRuns: 0,
      }),
    ).rejects.toThrow();
    hold.open();
    await until(() => reviewed(r.w, b.id));
  });

  it("does not start a second run of a task whose run has not ended", async () => {
    const hold = gate();
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (request.lastRole === "toolResult") return say("finished");
      await hold.opened;
      return call("finish_task", { summary: "ok" });
    });
    const task = make(r, "One at a time");
    await until(() => runStatuses(r.w, task.id)[0] === "running");
    await expect(
      r.w.client.call("tasks", "rerun", { taskId: task.id }),
    ).rejects.toThrow(/already has a run/);
    hold.open();
    await until(() => reviewed(r.w, task.id));
  });
});

describe("talking to a run", () => {
  it("delivers a comment on the task to the run that is going, as a message in its session", async () => {
    const hold = gate();
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (request.index === 1) {
        await hold.opened;
        return call("bash", { command: "echo working" });
      }
      if (request.last.includes("your summary is posted"))
        return say("finished");
      return request.transcript.join("\n").includes("use the staging db")
        ? call("finish_task", { summary: "Used the staging db." })
        : say("nothing");
    });
    // The conversation's own reply is request 0.
    await r.w.send(r.group.id, "hello");
    const task = make(r, "Migrate");
    await until(() => runStatuses(r.w, task.id)[0] === "running");
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "use the staging db",
    });
    hold.open();
    await until(() => reviewed(r.w, task.id));
    const mine = r.requests.filter(isRun);
    expect(mine.at(-1)!.transcript.join("\n")).toContain(
      "A comment from the user on task #1:\n\nuse the staging db",
    );
    // The comment is the user's on the timeline once, and the executor's own words are not
    // sent back to it.
    expect(
      r.w.host.product.board
        .activity(task.id)
        .filter((entry) => entry.kind === "comment")
        .map((entry) => entry.body),
    ).toEqual(["use the staging db", "Used the staging db."]);
  });

  it("records a comment that has no run to read it, on a task nobody is working on", async () => {
    const r = await room(finishes());
    const task = make(r, "Done already");
    await until(() => reviewed(r.w, task.id));
    await r.w.client.call("tasks", "update", {
      taskId: task.id,
      status: "done",
    });
    const before = r.requests.length;
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "thanks",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.requests.length).toBe(before);
    expect(runStatuses(r.w, task.id)).toEqual(["completed"]);
    // It is still a line on the timeline, for whoever reads the task next.
    expect(
      activityKinds(r.w, task.id).filter((kind) => kind === "comment"),
    ).toHaveLength(2);
  });
});

describe("a comment that wakes the task", () => {
  /**
   * A task that was reported, and a comment answering that report: the executor is woken again in
   * the session it already worked in, so what it read and did is above it and the comment is the
   * next thing said to it, not a new brief.
   */
  async function woken(
    first: string,
    comment: string,
    options: { status?: "in_review" | "blocked" } = {},
  ) {
    const r = await room((request) => {
      if (!isRun(request)) return say("ok");
      const carried = request.transcript
        .join("\n")
        .includes("your earlier run worked in");
      if (request.lastRole === "toolResult")
        return say(carried ? "done" : first);
      // The comment, and what it asks for, is what the second run is here for.
      return request.transcript.join("\n").includes(comment)
        ? call("finish_task", { summary: "Did the extra bit." })
        : call("finish_task", {
            summary: first,
            ...(options.status === undefined ? {} : { status: options.status }),
          });
    });
    // The conversation's own reply is request 0.
    await r.w.send(r.group.id, "hello");
    const task = make(r, "Carry on");
    await until(() => runStatuses(r.w, task.id).join() === "completed");
    return { ...r, task };
  }

  it("is another run of the task, in the same session, told the comment and not the whole brief", async () => {
    const r = await woken(
      "I moved the check into validate().",
      "also cover the empty case",
    );
    const before = r.requests.length;
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "also cover the empty case",
    });
    await until(
      () => runStatuses(r.w, r.task.id).join() === "completed,completed",
    );

    const [first, second] = runsOf(r.w, r.task.id);
    // It is a new run, and not a new session: it continues the one that reported.
    expect(second!.continuesRunId).toBe(first!.id);
    expect(first!.continuesRunId).toBeNull();
    expect(second!.sessionId).toBe(first!.sessionId);
    // The task was pulled back into being worked on, and the timeline says so.
    expect(activityKinds(r.w, r.task.id)).toEqual(
      expect.arrayContaining([
        "run_queued",
        "run_started",
        "run_completed",
        "status",
        "comment",
      ]),
    );
    expect(
      r.w.host.product.board
        .activity(r.task.id)
        .filter((entry) => entry.kind === "status")
        .map((entry) => entry.data),
    ).toContainEqual({ from: "in_review", to: "in_progress" });
    expect(taskOf(r.w, r.task.id).status).toBe("in_review");

    const again = r.requests.slice(before).filter(isRun);
    const told = again[0]!.transcript;
    // It remembers: the briefing it was first given, and its own report, are still above it.
    expect(told[0]).toContain("Do Carry on");
    expect(told.join("\n")).toContain("I moved the check into validate().");
    // The comment is what it is asked, and the brief is not repeated on top of it.
    expect(again[0]!.last).toContain(
      "A comment from the user on task #1:\n\nalso cover the empty case",
    );
    expect(again[0]!.last).toContain("again");
    expect(again[0]!.last).toContain("in review");
    expect(again[0]!.last).not.toContain(
      'You are the executor of task #1, "Carry on". This',
    );
    // What it costs: the second run reads the whole exchange, not just the comment.
    expect(told.length).toBeGreaterThan(2);
  });

  it("is the answer to what the executor asked for, and it carries on without reading the project again", async () => {
    const r = await woken(
      "I need the staging credentials to go on.",
      "they are in /etc/staging.env",
      { status: "blocked" },
    );
    expect(taskOf(r.w, r.task.id).status).toBe("blocked");
    const before = r.requests.length;
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "they are in /etc/staging.env",
    });
    await until(
      () => runStatuses(r.w, r.task.id).join() === "completed,completed",
    );

    const [first, second] = runsOf(r.w, r.task.id);
    expect(second!.sessionId).toBe(first!.sessionId);
    const asked = r.requests.slice(before).filter(isRun);
    // It was told the answer, where it stopped, and not a new brief to go and find out again.
    expect(asked[0]!.last).toContain("You stopped because you needed the user");
    expect(asked[0]!.last).toContain("they are in /etc/staging.env");
    // The first thing above it is still its own first briefing: it did not start over.
    expect(asked[0]!.transcript[0]).toContain("Do Carry on");
    expect(taskOf(r.w, r.task.id).status).toBe("in_review");
  });

  it("files the woken run's model requests and its questions under the task's own conversation", async () => {
    let questionAsked = false;
    let wokenReported = false;
    const { models, requests } = scriptedModels((request) => {
      if (!isRun(request)) return say("ok");
      const told = request.transcript.join("\n");
      // The run that was woken by the comment is the one whose journal carries the carry-on note.
      const carried = told.includes("your earlier run worked in");
      if (request.lastRole === "toolResult") {
        if (!carried) return say("Read the config, changed two lines.");
        if (wokenReported) return say("done");
        // It asked, was answered, and now reports what it did with the answer.
        wokenReported = true;
        return call("finish_task", { summary: "Staging, then." });
      }
      if (!carried)
        return call("finish_task", {
          summary: "Read the config, changed two lines.",
        });
      if (questionAsked) return say("nothing more");
      questionAsked = true;
      return call(
        "ask_user",
        { question: "Which env, staging or prod?" },
        "q-1",
      );
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "login");
    await w.watch(group.id);
    await w.send(group.id, "hello");
    const task = make({ w, ada, group }, "Carry on");
    await until(() => runStatuses(w, task.id).join() === "completed");
    await w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "ship it",
    });
    await until(() => runStatuses(w, task.id).join() === "completed,running");
    const [first, second] = runsOf(w, task.id);
    expect(second!.sessionId).toBe(first!.sessionId);

    /** The questions the woken run has asked, as the inbox filed them. */
    const asked = () =>
      w.host.db
        .query<Record<string, unknown>, []>(
          "SELECT conversation_id, session_id, reply_id, status FROM interaction",
        )
        .all();
    await until(() => asked().length === 1);
    // An executor woken in its old session can still ask the user something.
    expect(requests.at(-1)!.tools).toContain("ask_user");
    // The question reached the conversation the task came from, not the key the session is held in
    // and not the run that first opened it.
    expect(asked()).toEqual([
      {
        conversation_id: group.id,
        session_id: first!.sessionId,
        reply_id: null,
        status: "pending",
      },
    ]);
    await w.client.call("inbox", "answer", {
      id: `${second!.sessionId}:q-1`,
      response: { kind: "freeform", text: "staging" },
    });
    await until(() => runStatuses(w, task.id).join() === "completed,completed");

    // Both runs of the session are counted for that conversation, and neither leaves a `task:`
    // or `task-run:` key behind in the usage it wrote.
    const rows = w.host.db
      .query<{ conversation_id: string | null; session_id: string }, []>(
        "SELECT conversation_id, session_id FROM usage",
      )
      .all();
    const ofTask = rows.filter((row) => row.session_id === first!.sessionId);
    expect(ofTask.length).toBeGreaterThan(1);
    expect([...new Set(ofTask.map((row) => row.conversation_id))]).toEqual([
      group.id,
    ]);
  });

  it("wakes a task once, however often the same client sends the same comment", async () => {
    const r = await woken("Ready for you.", "one more thing");
    for (const _ of [1, 2]) {
      await r.w.client.call("tasks", "comment", {
        taskId: r.task.id,
        body: "one more thing",
        clientId: "retry-me",
      });
    }
    await until(
      () => runStatuses(r.w, r.task.id).join() === "completed,completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runStatuses(r.w, r.task.id)).toEqual(["completed", "completed"]);
    expect(
      r.w.host.product.board
        .activity(r.task.id)
        .filter(
          (entry) =>
            entry.kind === "comment" && entry.body === "one more thing",
        ),
    ).toHaveLength(1);
  });

  it("leaves a task alone once it is done or cancelled, and a task in the backlog was never claimed", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const r = await woken("Reported.", "changed my mind", {
        status: "in_review",
      });
      await r.w.client.call("tasks", "update", { taskId: r.task.id, status });
      const before = r.requests.length;
      await r.w.client.call("tasks", "comment", {
        taskId: r.task.id,
        body: "changed my mind",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(r.requests.length).toBe(before);
      expect(runStatuses(r.w, r.task.id)).toEqual(["completed"]);
      // The words are kept, where a person reading the task will find them.
      expect(
        r.w.host.product.board
          .activity(r.task.id)
          .some(
            (entry) =>
              entry.kind === "comment" && entry.body === "changed my mind",
          ),
      ).toBe(true);
    }

    const r = await room(finishes());
    const task = r.w.host.product.board.create(
      {
        title: "Not claimed",
        description: "Someday",
        status: "backlog",
        conversationId: r.group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: r.ada.id },
    );
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "while you're there",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.requests.filter(isRun)).toHaveLength(0);
    expect(runsOf(r.w, task.id)).toEqual([]);
  });

  it("does not wake a task that has a run going, and does not tell it the same thing twice", async () => {
    const hold = gate();
    let reported = false;
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (reported) return say("finished");
      if (request.index === 1) await hold.opened;
      reported = true;
      return call("finish_task", { summary: "ok" });
    });
    await r.w.send(r.group.id, "hello");
    const task = make(r, "Busy");
    await until(() => runStatuses(r.w, task.id)[0] === "running");
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "use the staging db",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The comment went into the run that was going: it did not ask for another one.
    expect(runsOf(r.w, task.id)).toHaveLength(1);
    hold.open();
    await until(() => reviewed(r.w, task.id));
    expect(runStatuses(r.w, task.id)).toEqual(["completed"]);
    const told = r.requests.filter(isRun).at(-1)!.transcript.join("\n");
    expect(told).toContain("use the staging db");
    // Steered once, and not again by the wake that a comment would otherwise have asked for.
    expect(told.split("use the staging db").length - 1).toBe(1);
  });

  it("waits its turn like any run when the machine it belongs to is offline", async () => {
    const { r, ada, group } = await remote(
      finishes("Reported from over there."),
    );
    const task = make({ w: r, ada, group }, "Over there, twice");
    await until(() => reviewed(r, task.id));
    await r.daemon.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    await r.client.call("tasks", "comment", {
      taskId: task.id,
      body: "and add the screenshot",
    });
    // The wake is a run in the queue, held by the same reason as a first run would be.
    await until(() => runsOf(r, task.id).length === 2);
    expect(runsOf(r, task.id)[1]).toMatchObject({
      status: "queued",
      queueReason: "machine_offline",
      continuesRunId: runsOf(r, task.id)[0]!.id,
    });
  });
});

describe("stopping and running again", () => {
  it("interrupts a run that is going: it ends interrupted and the task stays where it was", async () => {
    const r = await room((request) => (isRun(request) ? HANG : say("ok")));
    const task = make(r, "Endless");
    await until(() => runStatuses(r.w, task.id)[0] === "running");
    const [run] = runsOf(r.w, task.id);
    await r.w.client.call("tasks", "interrupt", {
      taskId: task.id,
      runId: run!.id,
    });
    await until(() => runStatuses(r.w, task.id)[0] === "interrupted");
    expect(taskOf(r.w, task.id)).toMatchObject({
      status: "in_progress",
      runStatus: "interrupted",
    });
    expect(activityKinds(r.w, task.id)).toContain("run_interrupted");
    await expect(
      r.w.client.call("tasks", "interrupt", {
        taskId: task.id,
        runId: run!.id,
      }),
    ).rejects.toThrow(/already ended/);
  });

  it("interrupts a run that waits, so it never starts; and stops the runs of a task moved to done", async () => {
    const r = await room((request) => (isRun(request) ? HANG : say("ok")));
    const machine = primaryOf(r.w);
    await r.w.client.call("machines", "setMaxActiveRuns", {
      machineId: machine.id,
      maxActiveRuns: 1,
    });
    const [a, b] = [make(r, "A"), make(r, "B")];
    await until(() => runStatuses(r.w, a.id)[0] === "running");
    const waiting = runsOf(r.w, b.id)[0]!;
    expect(waiting.status).toBe("queued");
    await r.w.client.call("tasks", "interrupt", {
      taskId: b.id,
      runId: waiting.id,
    });
    expect(runStatuses(r.w, b.id)).toEqual(["interrupted"]);
    expect(runsOf(r.w, b.id)[0]!.sessionId).toBeNull();

    await r.w.client.call("tasks", "update", { taskId: a.id, status: "done" });
    await until(() => runStatuses(r.w, a.id)[0] === "interrupted");
  });

  it("runs again in a new fresh session that remembers nothing of the earlier run", async () => {
    const r = await room(finishes("SECRET-OF-THE-FIRST-RUN"));
    const task = make(r, "Twice");
    await until(() => reviewed(r.w, task.id));
    await r.w.client.call("tasks", "rerun", { taskId: task.id });
    await until(
      () => runStatuses(r.w, task.id).join() === "completed,completed",
    );
    const [first, second] = runsOf(r.w, task.id);
    expect(second!.sessionId).not.toBe(first!.sessionId);
    const [, again] = r.requests.filter(
      (request) =>
        isRun(request) && request.index >= 0 && request.lastRole === "user",
    );
    expect(again!.transcript.join("\n")).not.toContain(
      "SECRET-OF-THE-FIRST-RUN",
    );
  });

  it("fails a run that stops without reporting, after one reminder", async () => {
    const r = await room((request) =>
      say(isRun(request) ? "I think I am done" : "ok"),
    );
    const task = make(r, "Forgetful");
    await until(() => runStatuses(r.w, task.id)[0] === "failed");
    expect(runsOf(r.w, task.id)[0]!.error).toMatch(
      /without calling finish_task/,
    );
    expect(activityKinds(r.w, task.id)).toEqual(
      expect.arrayContaining(["run_nudged", "run_failed"]),
    );
    const mine = r.requests.filter(isRun);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.last).toContain("You stopped without calling finish_task");
  });

  it("ends the runs a restart cut off as failed", async () => {
    const dataDir = await tempDir();
    const { models } = scriptedModels((request) =>
      isRun(request) ? HANG : say("ok"),
    );
    const first = await world({ dataDir, models, captain: false });
    const ada = await first.agent("Ada");
    const project = await first.project({ stewardId: ada.id });
    const group = await first.group(project.id, [ada.id]);
    const task = first.host.product.board.create(
      {
        title: "Cut off",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    await until(() => runStatuses(first, task.id)[0] === "running");
    await first.host.close();

    const second = await testHost({
      dataDir,
      models: scriptedModels(() => say("ok")).models,
      captain: false,
    });
    const client = await connect(`ws://127.0.0.1:${second.port}/ws`);
    await client.hello();
    const rows = () =>
      second.db
        .query<{ status: string; error: string | null }, []>(
          "SELECT status, error FROM task_run",
        )
        .all();
    expect(rows()).toEqual([
      {
        status: "failed",
        error: "The server restarted before this run finished.",
      },
    ]);
    client.close();
  });
});

describe("a task run on a daemon's machine", () => {
  it("works on the machine the project is on, through the link, and reports back", async () => {
    const { r, ada, group } = await remote(finishes("Done over there."));
    const task = make({ w: r, ada, group }, "Over there");
    await until(() => reviewed(r, task.id));
    const [run] = runsOf(r, task.id);
    expect(run!.workspace).toBe(r.dir);
    // The session's journal is the daemon's, and the primary's session host has none of it.
    expect(await readdir(join(r.daemon.dataDir, "sessions"))).toContain(
      run!.sessionId,
    );
    expect(existsSync(join(r.host.dataDir, "sessions", run!.sessionId!))).toBe(
      false,
    );
    const result = r
      .rows(group.id)
      .find((row) => row.data.event === "task_result")!;
    expect(result.text).toContain("Done over there.");
  });

  it.skipIf(process.platform === "win32")(
    "makes its worktree on the daemon's machine",
    async () => {
      const home = await tempDir("eta-home-");
      const saved = process.env.HOME;
      process.env.HOME = home;
      try {
        const { r, ada, group } = await remote(finishes());
        git(r.dir, "init", "-q", "-b", "main");
        git(r.dir, "commit", "-q", "--allow-empty", "-m", "init");
        const task = make({ w: r, ada, group }, "Branchy", "worktree");
        await until(() => reviewed(r, task.id));
        const where = join(
          home,
          ".eta",
          "worktrees",
          r.remoteProject.id,
          "task-1",
        );
        expect(taskOf(r, task.id).workspace).toMatchObject({
          mode: "worktree",
          path: where,
          branch: "eta/task-1",
        });
        expect(existsSync(where)).toBe(true);
        expect(existsSync(join(r.host.dataDir, "worktrees"))).toBe(false);
        expect(git(r.dir, "branch", "--list", "eta/task-1")).toContain(
          "eta/task-1",
        );
      } finally {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
      }
    },
  );

  it("carries a comment's wake into the same session on the other machine", async () => {
    const { r, ada, group } = await remote(
      finishes("Reported from over there."),
    );
    const task = make({ w: r, ada, group }, "Over there, twice");
    await until(() => reviewed(r, task.id));
    const [first] = runsOf(r, task.id);
    const journals = await readdir(join(r.daemon.dataDir, "sessions"));

    await r.client.call("tasks", "comment", {
      taskId: task.id,
      body: "and add the screenshot",
    });
    await until(() => runStatuses(r, task.id).join() === "completed,completed");

    const second = runsOf(r, task.id)[1]!;
    expect(second.continuesRunId).toBe(first!.id);
    expect(second.sessionId).toBe(first!.sessionId);
    // No second session was made on that machine: the wake carried on in the one it had, and every
    // request it made was still accepted as that machine's own.
    expect(await readdir(join(r.daemon.dataDir, "sessions"))).toEqual(journals);
    const results = r
      .rows(group.id)
      .filter((row) => row.data.event === "task_result");
    expect(results).toHaveLength(2);
  });

  it("streams a remote task run's activity to its liveness watcher", async () => {
    const { r, ada, group } = await remote(finishes());
    const link = r.host.product.hub.link(r.daemon.machineId)!;
    const original = link.daemon.bind(link);
    const activity: unknown[] = [];
    link.daemon = ((method, params, options) => {
      if (options?.onEvent === undefined)
        return original(method, params, options);
      return original(method, params, {
        ...options,
        onEvent: (event) => {
          activity.push(event);
          options.onEvent?.(event);
        },
      });
    }) as typeof link.daemon;
    try {
      const task = make({ w: r, ada, group }, "Watch while it runs");
      await until(() => reviewed(r, task.id));
    } finally {
      link.daemon = original as typeof link.daemon;
    }

    expect(activity).toEqual(
      expect.arrayContaining([
        { kind: "message" },
        { kind: "tool-start" },
        { kind: "tool-end" },
      ]),
    );
  });

  it("waits while the machine is offline and starts when it is back", async () => {
    const { r, ada, group } = await remote(finishes());
    await r.daemon.stop();
    await until(
      () => machineView(r.client, r.daemon.machineId)?.status === "offline",
    );
    const task = make({ w: r, ada, group }, "Later");
    await until(() => runsOf(r, task.id)[0]?.queueReason === "machine_offline");
    expect(runStatuses(r, task.id)).toEqual(["queued"]);

    // The same daemon comes back on its directory, and the waiting run starts.
    const node = new DaemonNode({
      dataDir: r.daemon.dataDir,
      version: "test",
      warn: () => undefined,
    });
    await node.start();
    const link = new DaemonLink({
      identity: r.daemon.identity,
      server: node,
      backoff: { minMs: 20, maxMs: 100 },
    });
    link.start();
    try {
      await until(() => reviewed(r, task.id), 20_000);
    } finally {
      await link.stop();
      await node.close();
    }
  });
});
