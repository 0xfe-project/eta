/**
 * An agent pinned to a machine: its sessions are made there whatever machine the project is on,
 * and an agent away from its project's machine is told so where the user does not see it (its
 * system prompt), never in the conversation.
 */
import type { AgentRuntimeInfo, MessageView } from "@eta/client-contracts";
import type { OarRuntimes } from "@eta/runtime-oar";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";

const AWAY =
  /<system-reminder>\nYou are running on laptop, not on the machine this conversation belongs to \(desk\)\./;

/** A host and a daemon, named so the note can be read: the primary is `desk`, the daemon `laptop`. */
async function named(
  options: Parameters<typeof remoteWorld>[0] = {},
  daemon = {},
) {
  const r = await remoteWorld(options, daemon);
  const primary = r.client
    .section<{ id: string; kind: string }[]>("machines", "list")!
    .find((machine) => machine.kind === "primary")!;
  await r.client.call("machines", "rename", {
    machineId: primary.id,
    name: "desk",
  });
  await r.client.call("machines", "rename", {
    machineId: r.daemon.machineId,
    name: "laptop",
  });
  return { ...r, primaryId: primary.id };
}

describe("an agent pinned to a daemon machine", () => {
  it("answers from there in a project on the primary, told so out of the transcript's sight", async () => {
    const { models, requests } = scriptedModels(() => say("from the laptop"));
    const r = await named({ models });
    const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
    expect(ada.machineId).toBe(r.daemon.machineId);
    const project = await r.project();
    const group = await r.group(project.id, [ada.id]);
    await r.watch(group.id);

    const sent = await r.send(group.id, "hi");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done).toMatchObject({ status: "done", text: "from the laptop" });

    // The session is the daemon's, though the project is the primary's.
    const session = sessionOf(r, group.id)!;
    expect(existsSync(join(r.daemon.dataDir, "sessions", session))).toBe(true);
    expect(existsSync(join(r.host.dataDir, "sessions", session))).toBe(false);

    // Told in the system prompt, and nowhere the user reads.
    expect(requests[0]!.system).toMatch(AWAY);
    expect(requests[0]!.transcript.join("\n")).not.toContain("system-reminder");
    const rows = r.client.section<{ messages: MessageView[] }>(
      `conversations.${group.id}`,
      "timeline",
    )!.messages;
    expect(JSON.stringify(rows)).not.toContain("system-reminder");
  });

  it("is not told anything in a project on its own machine", async () => {
    const { models, requests } = scriptedModels(() => say("at home"));
    const r = await named({ models });
    const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
    const group = await r.group(r.remoteProject.id, [ada.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "hi");
    await r.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.system).not.toContain("system-reminder");
  });

  it("moved back to follow the project, starts a new session on the project's machine", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const r = await named({ models });
    const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
    const project = await r.project();
    const group = await r.group(project.id, [ada.id]);
    await r.watch(group.id);
    const first = await r.send(group.id, "one");
    await r.settled(group.id, first.replies[0]!.id);
    const remote = sessionOf(r, group.id)!;

    await r.client.call("agents", "update", {
      agentId: ada.id,
      machineId: null,
    });
    const second = await r.send(group.id, "two");
    await r.settled(group.id, second.replies[0]!.id);
    await until(() => sessionOf(r, group.id) !== remote);
    const local = sessionOf(r, group.id)!;
    expect(existsSync(join(r.host.dataDir, "sessions", local))).toBe(true);
    expect(requests[1]!.system).not.toContain("system-reminder");
  });
});

describe("a task of a pinned agent", () => {
  it("runs on the agent's machine, in its home rather than a worktree of a project it does not have", async () => {
    const { models, requests } = scriptedModels((request) =>
      !request.system.includes("In this task you are")
        ? say("ok")
        : request.lastRole === "toolResult"
          ? say("finished")
          : call("finish_task", { summary: "Done over here." }),
    );
    const r = await named({ models });
    const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
    const project = await r.project();
    const group = await r.group(project.id, [ada.id]);
    const task = r.host.product.board.create(
      {
        title: "Over there",
        description: "Do it",
        status: "todo",
        conversationId: group.id,
        workspace: "worktree",
      },
      { kind: "agent", agentId: ada.id },
    );
    await until(
      () => r.host.product.board.detail(task.id)?.status === "in_review",
      15_000,
    );
    const row = r.host.db
      .query<
        { machine_id: string; workspace: string; session_id: string },
        [string]
      >(
        "SELECT machine_id, workspace, session_id FROM task_run WHERE task_id = ?",
      )
      .get(task.id)!;
    expect(row.machine_id).toBe(r.daemon.machineId);
    // Not a worktree of the project (that is the primary's directory): the machine's home.
    expect(row.workspace).not.toContain("worktrees");
    expect(existsSync(join(r.daemon.dataDir, "sessions", row.session_id))).toBe(
      true,
    );
    const executor = requests.find((request) =>
      request.system.includes("In this task you are"),
    )!;
    expect(executor.system).toContain(
      "You are running on laptop, not on the machine this task belongs to (desk).",
    );
    // Its brief does not claim a project directory it does not have.
    expect(executor.transcript[0]).toContain(
      "## Where you work\n\nYou start in ",
    );
    expect(executor.transcript[0]).not.toContain("the project's directory");
  });
});

describe("where a task runs: its executor's machine", () => {
  /** A task run to review on a scripted model, and the row of its one run. */
  async function ran(
    make: (r: Awaited<ReturnType<typeof named>>) => Promise<{
      task: { id: string };
      executor: string;
    }>,
  ) {
    const { models, requests } = scriptedModels((request) =>
      !request.system.includes("In this task you are")
        ? say("ok")
        : request.lastRole === "toolResult"
          ? say("finished")
          : call("finish_task", { summary: "Done." }),
    );
    const r = await named({ models });
    const { task, executor } = await make(r);
    await until(
      () => r.host.product.board.detail(task.id)?.status === "in_review",
      15_000,
    );
    const row = r.host.db
      .query<{ machine_id: string; session_id: string }, [string]>(
        "SELECT machine_id, session_id FROM task_run WHERE task_id = ?",
      )
      .get(task.id)!;
    const brief = requests.find((request) =>
      request.system.includes("In this task you are"),
    )!;
    return { r, row, brief, executor };
  }

  it("a task one agent made and assigned to another pinned elsewhere runs on the assignee's machine", async () => {
    const { r, row, brief } = await ran(async (r) => {
      // Ada follows the project (the primary's); Bob is pinned to the laptop.
      const ada = await r.agent("Ada");
      const bob = await r.agent("Bob", { machineId: r.daemon.machineId });
      const project = await r.project();
      const group = await r.group(project.id, [ada.id, bob.id]);
      const task = r.host.product.board.create(
        {
          title: "For Bob",
          description: "Do it",
          status: "todo",
          conversationId: group.id,
          workspace: "local",
          assignee: bob.id,
        },
        { kind: "agent", agentId: ada.id },
      );
      return { task, executor: bob.id };
    });
    expect(row.machine_id).toBe(r.daemon.machineId);
    expect(existsSync(join(r.daemon.dataDir, "sessions", row.session_id))).toBe(
      true,
    );
    expect(brief.system).toContain("In this task you are Bob");
    expect(brief.system).toContain(
      "You are running on laptop, not on the machine this task belongs to (desk).",
    );
  });

  it("a task the user made for a pinned agent runs on that agent's machine", async () => {
    const { r, row } = await ran(async (r) => {
      const bob = await r.agent("Bob", { machineId: r.daemon.machineId });
      const project = await r.project();
      const group = await r.group(project.id, [bob.id]);
      const [task] = r.host.product.board.make(
        {
          tasks: [
            { title: "Mine, for Bob", description: "Do it", assignee: bob.id },
          ],
          conversationId: group.id,
          workspace: "local",
        },
        { kind: "user", agentId: null },
      );
      return { task: task!, executor: bob.id };
    });
    expect(row.machine_id).toBe(r.daemon.machineId);
  });

  it("a task a pinned agent made and assigned to one that follows the project runs on the project's machine", async () => {
    const { r, row, brief } = await ran(async (r) => {
      // The maker is pinned away; the executor is not, so the run is the project's.
      const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
      const bob = await r.agent("Bob");
      const project = await r.project();
      const group = await r.group(project.id, [ada.id, bob.id]);
      const task = r.host.product.board.create(
        {
          title: "For Bob, here",
          description: "Do it",
          status: "todo",
          conversationId: group.id,
          workspace: "local",
          assignee: bob.id,
        },
        { kind: "agent", agentId: ada.id },
      );
      return { task, executor: bob.id };
    });
    expect(row.machine_id).toBe(r.primaryId);
    expect(existsSync(join(r.host.dataDir, "sessions", row.session_id))).toBe(
      true,
    );
    expect(brief.system).toContain("In this task you are Bob");
    expect(brief.system).not.toContain("system-reminder");
  });

  it("an agent's own task, with no assignee, runs on the maker's machine as before", async () => {
    const { r, row } = await ran(async (r) => {
      const ada = await r.agent("Ada", { machineId: r.daemon.machineId });
      const project = await r.project();
      const group = await r.group(project.id, [ada.id]);
      const task = r.host.product.board.create(
        {
          title: "Mine",
          description: "Do it",
          status: "todo",
          conversationId: group.id,
          workspace: "local",
        },
        { kind: "agent", agentId: ada.id },
      );
      return { task, executor: ada.id };
    });
    expect(row.machine_id).toBe(r.daemon.machineId);
  });
});

describe("an agent pinned to the primary", () => {
  it("answers here in a project on a daemon machine, and is told so", async () => {
    const { models, requests } = scriptedModels(() => say("from the desk"));
    const r = await named({ models });
    const ada = await r.agent("Ada", { machineId: r.primaryId });
    const group = await r.group(r.remoteProject.id, [ada.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "hi");
    await r.settled(group.id, sent.replies[0]!.id);
    const session = sessionOf(r, group.id)!;
    expect(existsSync(join(r.host.dataDir, "sessions", session))).toBe(true);
    expect(requests[0]!.system).toContain(
      "You are running on desk, not on the machine this conversation belongs to (laptop).",
    );
  });
});

describe("pinning", () => {
  it("refuses a machine that is not there, or was removed", async () => {
    const r = await named();
    await expect(r.agent("Ada", { machineId: "nope" })).rejects.toThrow(
      /no such machine/,
    );
    await r.client.call("machines", "remove", {
      machineId: r.daemon.machineId,
    });
    await expect(
      r.agent("Bob", { machineId: r.daemon.machineId }),
    ).rejects.toThrow(/no such machine/);
  });

  it("a daemon machine's runtimes are asked of that machine", async () => {
    const theirs: AgentRuntimeInfo[] = [
      {
        id: "claude",
        label: "Claude Code",
        status: "available",
        models: [{ id: "sonnet", name: "Sonnet", default: true, efforts: [] }],
      },
    ];
    const runtimes = {
      catalog: { list: async () => theirs },
      open: () => undefined,
    } as unknown as OarRuntimes;
    const r = await named({}, { node: { runtimes } });
    expect(
      await r.client.call("agents", "runtimes", {
        machineId: r.daemon.machineId,
      }),
    ).toEqual({ runtimes: theirs });
    // The primary's own (none, in a test host) when no machine is named.
    expect(await r.client.call("agents", "runtimes", {})).toEqual({
      runtimes: [],
    });
  });
});
