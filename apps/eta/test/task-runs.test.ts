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
import { demoFiles, SECRET, writeBundle } from "./support/bundles";
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
): BoardTaskDetail =>
  r.w.host.product.board.create(
    {
      title,
      description: `Do ${title}`,
      status: "todo",
      conversationId: r.group.id,
      workspace,
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

describe("a task run", () => {
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
        "bash",
        "read",
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

  it("is equipped as the agent's conversation sessions are: its bundles' skills, MCP tools and hook rules", async () => {
    const home = await tempDir("eta-home-");
    await writeBundle(home, "demo", demoFiles());
    const { models, requests } = scriptedModels(finishes());
    const w = await world({ dataDir: home, models });
    const ada = await w.agent("Ada", { bundles: ["demo"] });
    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "login");
    const task = make({ w, ada, group }, "With a bundle");
    await until(() => reviewed(w, task.id));
    const [first] = requests.filter(isRun);
    expect(first!.system).toContain("demo-skill");
    expect(first!.tools).toEqual(
      expect.arrayContaining(["mcp", "finish_task"]),
    );
    expect(first!.transcript.join("\n")).toContain(
      `hook-token-len:${SECRET.length}`,
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

  it("takes a comment on a task with no run going as a comment and nothing more", async () => {
    const r = await room(finishes());
    const task = make(r, "Done already");
    await until(() => reviewed(r.w, task.id));
    const before = r.requests.length;
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "thanks",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.requests.length).toBe(before);
    expect(runStatuses(r.w, task.id)).toEqual(["completed"]);
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

  it("ends the runs a restart cut off as failed, and runs the ones that were waiting", async () => {
    const dataDir = await tempDir();
    const { models } = scriptedModels((request) =>
      isRun(request) ? HANG : say("ok"),
    );
    const first = await world({ dataDir, models });
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
    });
    const client = await connect(`ws://127.0.0.1:${second.port}/ws`);
    await client.hello();
    const rows = second.db
      .query<{ status: string; error: string | null }, []>(
        "SELECT status, error FROM task_run",
      )
      .all();
    expect(rows).toEqual([
      {
        status: "failed",
        error: "The server restarted before this run finished.",
      },
    ]);
    client.close();
  });
});

describe("a task run on a daemon's machine", () => {
  async function remote(respond: Parameters<typeof room>[0]) {
    const { models, requests } = scriptedModels(respond);
    const r = await remoteWorld({ models });
    const { agents, group } = await r.agents("Ada");
    return { r, requests, ada: agents[0]!, group };
  }

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

  it("makes its worktree on the daemon's machine", async () => {
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
