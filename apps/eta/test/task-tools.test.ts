/**
 * The tools an agent has for the board: they are on the sessions of agents in a conversation and
 * on no other, they act as the agent, in its conversation, and a refusal comes back as a tool
 * error the model can read.
 */
import type {
  BoardTaskView,
  TaskActivityView,
  TaskCardData,
} from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const TOOLS = [
  "draft_task",
  "list_tasks",
  "get_task",
  "create_task",
  "update_task",
  "comment_task",
];

/** An agent that makes the calls it is given, one per model request, and then says it is done. */
function script(calls: ReturnType<typeof call>[]) {
  const results: string[] = [];
  const { models, requests } = scriptedModels((request) => {
    if (request.lastRole === "toolResult") results.push(request.last);
    return calls[results.length] ?? say("done");
  });
  return { models, requests, results };
}

describe("the task tools", () => {
  it("are offered to an agent in a conversation, and to a bare session not at all", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "hi");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.tools).toEqual(expect.arrayContaining(TOOLS));

    const { session } = (await w.client.call("sessions", "create", {
      cwd: project.path,
    })) as { session: string };
    await w.client.call("sessions", "prompt", { session, text: "hello" });
    await until(() => requests.length === 2);
    expect(requests[1]!.tools).not.toContain("create_task");
    expect(requests[1]!.tools).not.toContain("draft_task");
  });

  it("make, read, change and comment on tasks as the agent, in its conversation", async () => {
    const { models, results } = script([
      call("create_task", {
        title: "Write the docs",
        description: "The README",
        workspace: "local",
      }),
      call("list_tasks", {}),
      call("update_task", { task: "#1", status: "in_review" }),
      call("comment_task", { task: "1", body: "ready for you" }),
      call("get_task", { task: "1" }),
      call("list_tasks", { status: "done" }),
    ]);
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    w.client.subscribe("tasks");

    const sent = await w.send(group.id, "please track the docs");
    const reply = await w.settled(group.id, sent.replies[0]!.id);
    expect(reply.text).toBe("done");
    expect(results).toHaveLength(6);

    expect(results[0]).toBe('Created task #1 "Write the docs".');
    expect(results[1]).toBe(
      "#1 [todo] Write the docs — never run, created by Ada",
    );
    expect(results[2]).toBe('#1 is now [in_review] "Write the docs".');
    expect(results[3]).toBe("Commented on #1.");
    // The task in full: its line, its description, and a timeline an agent can read.
    expect(results[4]).toContain(
      "#1 [in_review] Write the docs — never run, created by Ada",
    );
    expect(results[4]).toContain("The README");
    expect(results[4]).toMatch(/\[created\] Ada/);
    expect(results[4]).toMatch(/\[status\] Ada: todo -> in_review/);
    expect(results[4]).toMatch(/\[comment\] Ada: ready for you/);
    expect(results[5]).toBe("The board has no such tasks.");

    await until(
      () =>
        (w.client.section<BoardTaskView[]>("tasks", "list") ?? []).length === 1,
    );
    expect(
      w.client.section<BoardTaskView[]>("tasks", "list")![0],
    ).toMatchObject({
      number: 1,
      status: "in_review",
      comments: 1,
      // It is linked to the conversation the agent made it in, and credited to the agent.
      conversationId: group.id,
      createdBy: { kind: "agent", agentId: ada.id },
    });
    const task = w.host.db
      .query<{ id: string }, []>("SELECT id FROM task")
      .get()!;
    w.client.subscribe(`tasks.${task.id}`);
    await until(
      () => w.client.section(`tasks.${task.id}`, "activity") !== undefined,
    );
    const activity = w.client.section<TaskActivityView[]>(
      `tasks.${task.id}`,
      "activity",
    )!;
    expect(activity.map((entry) => entry.kind)).toEqual([
      "created",
      "status",
      "comment",
    ]);
    expect(activity.every((entry) => entry.actor.agentId === ada.id)).toBe(
      true,
    );
    // A task an agent made is not a draft: no card is put in the timeline.
    expect(w.rows(group.id).some((row) => row.kind === "task_card")).toBe(
      false,
    );
  });

  it("say a dependency's history in words a model reads, though the host writes only its data", async () => {
    const { models, results } = script([
      call("create_task", { title: "A" }),
      call("create_task", {
        title: "B",
        dependsOn: [{ task: "#1", requireDone: true }],
      }),
      call("update_task", { task: "#2", removeDependencies: ["#1"] }),
      call("get_task", { task: "2" }),
    ]);
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "go");
    await w.settled(group.id, sent.replies[0]!.id);

    const stored = w.host.db
      .query<{ body: string | null }, []>(
        "SELECT body FROM task_activity WHERE kind = 'dependency'",
      )
      .all();
    expect(stored.map((row) => row.body)).toEqual([null, null]);
    expect(results[3]).toMatch(
      /\[dependency\] Ada: Waits for #1 "A" \(only done resolves it\)\./,
    );
    expect(results[3]).toMatch(
      /\[dependency\] Ada: No longer waits for #1 "A"\./,
    );
  });

  it("report what the board refuses as an error the model reads", async () => {
    const { models, results } = script([
      call("create_task", { title: "x", status: "finished" }),
      call("get_task", { task: "99" }),
      call("update_task", { task: "99", title: "y" }),
      call("comment_task", { task: "99", body: "z" }),
      call("draft_task", { title: " ", goal: "g", acceptance: "a" }),
    ]);
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "go");
    await w.settled(group.id, sent.replies[0]!.id);

    expect(results[0]).toMatch(/status must be one of/);
    expect(results[1]).toBe("no such task: 99");
    expect(results[2]).toBe("no such task: 99");
    expect(results[3]).toBe("no such task: 99");
    expect(results[4]).toBe("a task needs a title");
    expect(w.host.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({
      n: 0,
    });
  });

  it("tell an agent a task is archived, write on it as asked, and say in the result that it brought it back", async () => {
    // One list of calls per message the agent is sent.
    const phases = [
      [
        call("create_task", { title: "Kept" }),
        call("create_task", { title: "Away" }),
        call("create_task", { title: "Also away" }),
      ],
      [
        call("list_tasks", { archived: "include" }),
        call("get_task", { task: "2" }),
        call("update_task", { task: "#2", title: "Renamed" }),
        call("comment_task", { task: "3", body: "one more thing" }),
        call("get_task", { task: "2" }),
        call("update_task", { task: "#1", title: "Kept still" }),
        call("comment_task", { task: "1", body: "fine" }),
      ],
    ];
    const results: string[] = [];
    let phase = -1;
    let step = 0;
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") results.push(request.last);
      else {
        phase += 1;
        step = 0;
      }
      return phases[phase]?.[step++] ?? say("done");
    });
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const first = await w.send(group.id, "make them");
    await w.settled(group.id, first.replies[0]!.id);
    const away = w.host.product.board.find("2")!;
    const alsoAway = w.host.product.board.find("3")!;
    // The user puts #2 and #3 away by hand, the way the board's Archive does.
    await w.client.call("tasks", "archive", { taskId: away.id });
    await w.client.call("tasks", "archive", { taskId: alsoAway.id });

    const second = await w.send(group.id, "go on");
    await w.settled(group.id, second.replies[0]!.id);
    const [
      listed,
      read,
      updated,
      commented,
      reread,
      plainUpdate,
      plainComment,
    ] = results.slice(3);

    // The reading tools say it is archived, by whom and when.
    expect(listed).toMatch(
      /#2 \[todo\] \[archived\] Away — .*; archived: the user archived it by hand at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: they put it away on purpose/,
    );
    expect(listed).toMatch(/^#1 \[todo\] Kept — never run, created by Ada$/m);
    expect(read).toMatch(
      /\nArchived: the user archived it by hand at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC.*Changing or commenting on it brings it back onto the board\./,
    );

    // Without any confirmation, the change is made, and the result says it undid the user's archive.
    expect(updated).toMatch(
      /^#2 is now \[todo\] "Renamed"\.\n\nNote: #2 was archived: the user archived it by hand at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: they put it away on purpose\. This change brought it back onto the board; tell the user\.$/,
    );
    expect(commented).toMatch(
      /^Commented on #3\.\n\nNote: #3 was archived: the user archived it by hand at .*This change brought it back onto the board; tell the user\.$/,
    );
    expect(reread).toMatch(
      /^#2 \[todo\] Renamed — never run, created by Ada\nWorks in/,
    );
    expect(w.host.product.board.find(away.id)!.archivedAt).toBeNull();
    expect(w.host.product.board.find(alsoAway.id)!.archivedAt).toBeNull();
    const comments = w.host.db
      .query<{ body: string }, [string]>(
        "SELECT body FROM task_activity WHERE task_id = ? AND kind = 'comment'",
      )
      .all(alsoAway.id);
    expect(comments.map((row) => row.body)).toEqual(["one more thing"]);

    // A task that is not archived gets no note.
    expect(plainUpdate).toBe('#1 is now [todo] "Kept still".');
    expect(plainComment).toBe("Commented on #1.");
  });

  it("let an agent hand a drafted task to the user, who confirms it and sees a card the agent keeps current", async () => {
    // Ada drafts; later, in the same conversation, she moves the task the user confirmed.
    let step = 0;
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say("ok");
      step += 1;
      return step === 1
        ? call("draft_task", {
            title: "Add tests",
            goal: "Cover the board",
            acceptance: "They pass",
            source: "第 1 条",
          })
        : call("update_task", { task: "1", status: "done" });
    });
    const w = await world({ models, tasks: { runs: false } });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    const first = await w.send(group.id, "tests?");
    await w.settled(group.id, first.replies[0]!.id);
    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    // What the agent said about where it came from is kept.
    expect(String(draft.data.description)).toContain("第 1 条.");
    await w.client.call("tasks", "confirmDraft", {
      conversationId: group.id,
      messageId: draft.id,
    });

    const second = await w.send(group.id, "all done?");
    await w.settled(group.id, second.replies[0]!.id);
    await until(
      () =>
        (w.row(group.id, draft.id)?.data as unknown as TaskCardData).status ===
        "done",
    );
    expect(w.row(group.id, draft.id)?.kind).toBe("task_card");
  });
});
