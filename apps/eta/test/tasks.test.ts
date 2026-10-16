import type { Host } from "../src/host";
/**
 * The task board, the local half (REFACTOR.md §9, P3.1).
 *
 * Two claims, and the second is the interesting one.
 *
 * The first is the board: a task has a number that is never reused, every change writes its own
 * line to the timeline, and a comment is what a card shows as its summary.
 *
 * The second is the bridge between the board and a conversation. An agent proposes work in a group
 * and what lands is a *message* — nothing on the board yet — because a proposal is something to
 * decide, not something to run. Confirming it creates the task and turns that same message into
 * the card, and every later change refreshes the card in place: one row, no second copy to drift.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";
import { sseReader } from "./support/sse";

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

interface Task {
  id: string;
  number: number;
  title: string;
  status: string;
  group_id: string | null;
  comments: number;
  assignee: { kind: string };
  created_by: { kind: string; agent_name: string | null };
  run_status: string | null;
}

interface TaskDetail extends Task {
  description: string;
  activity: {
    kind: string;
    body: string | null;
    data: Record<string, unknown>;
  }[];
}

interface Message {
  id: string;
  seq: number;
  kind: string;
  role: string;
  status: string;
  revision: number;
  data: Record<string, unknown>;
}

/** A model that drafts one task in the group it was woken in, then stops. */
const draftingModels = (args: Record<string, unknown>) =>
  fakeModels([
    assistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall" as const,
          id: "call-draft",
          name: "draft_task",
          arguments: args,
        },
      ],
    }),
    assistantMessage({ content: [{ type: "text", text: "草稿已提交。" }] }),
  ]);

async function start(
  models: ReturnType<typeof fakeModels> = fakeModels([]),
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-tasks-"));
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

const board = async (
  host: Host,
  query = "",
): Promise<{ tasks: Task[]; assignees: unknown[] }> =>
  (await (await send(host, "GET", `/api/v1/tasks${query}`)).json()) as {
    tasks: Task[];
    assignees: unknown[];
  };

const detail = async (host: Host, idOrNumber: string): Promise<TaskDetail> =>
  (await (
    await send(host, "GET", `/api/v1/tasks/${idOrNumber}`)
  ).json()) as TaskDetail;

const timeline = async (host: Host, groupId: string): Promise<Message[]> => {
  const page = (await (
    await send(host, "GET", `/api/v1/groups/${groupId}/messages`)
  ).json()) as { items: Message[] };
  return page.items;
};

describe("the board", () => {
  it("numbers tasks, keeps their timeline, and answers by number as well as by id", async () => {
    const host = await start();
    const first = (await (
      await send(host, "POST", "/api/v1/tasks", {
        title: "第一个",
        description: "写点什么",
      })
    ).json()) as TaskDetail;
    expect(first).toMatchObject({ number: 1, status: "todo", title: "第一个" });
    expect(first.activity.map((entry) => entry.kind)).toEqual(["created"]);

    // A second task gets the next number, and the numbers are the board's order for humans.
    const second = (await (
      await send(host, "POST", "/api/v1/tasks", {
        title: "第二个",
        status: "backlog",
      })
    ).json()) as TaskDetail;
    expect(second.number).toBe(2);
    expect(second.status).toBe("backlog");

    // A status change is its own line, with both ends of the move.
    await send(host, "PATCH", `/api/v1/tasks/${first.id}`, {
      status: "in_progress",
    });
    const moved = await detail(host, String(first.number));
    expect(moved.status).toBe("in_progress");
    const status = moved.activity.find((entry) => entry.kind === "status");
    expect(status?.data).toEqual({ from: "todo", to: "in_progress" });

    // A comment counts, and is what a card would show.
    await send(host, "POST", `/api/v1/tasks/${first.id}/comments`, {
      body: "开工了",
    });
    const commented = await detail(host, first.id);
    expect(commented.comments).toBe(1);
    expect(commented.activity.at(-1)).toMatchObject({
      kind: "comment",
      body: "开工了",
    });

    const list = await board(host);
    expect(list.tasks.map((task) => task.number).sort()).toEqual([1, 2]);
    // Nobody to assign remote work to yet, and an empty list says exactly that.
    expect(list.assignees).toEqual([]);

    expect(
      (await send(host, "DELETE", `/api/v1/tasks/${second.id}`)).status,
    ).toBe(204);
    expect((await board(host)).tasks.map((task) => task.number)).toEqual([1]);
  });

  it("refuses what this build cannot do rather than pretending", async () => {
    const host = await start();
    const remote = await send(host, "POST", "/api/v1/tasks", {
      title: "远程的活",
      assignee: { kind: "remote" },
    });
    expect(remote.status).toBe(422);
    expect(
      ((await remote.json()) as { error: { message: string } }).error.message,
    ).toContain("P4");

    expect(
      (await send(host, "POST", "/api/v1/tasks", { title: "  " })).status,
    ).toBe(422);
    expect((await send(host, "GET", "/api/v1/tasks/nope")).status).toBe(404);
    expect(
      (await send(host, "PATCH", "/api/v1/tasks/nope", { status: "done" }))
        .status,
    ).toBe(404);
  });
});

describe("a draft in a group", () => {
  it("becomes a card only when the user confirms it, and the card follows the task", async () => {
    const models = draftingModels({
      title: "把登录页改成邮箱登录",
      goal: "支持邮箱加密码登录",
      decided: "不做手机号",
      acceptance: "邮箱能登录,错误提示清楚",
    });
    const host = await start(models);
    const agent = (await (
      await send(host, "POST", "/agents", { name: "planner" })
    ).json()) as { agent: { id: string } };
    const group = (await (
      await send(host, "POST", "/groups", {
        name: "登录改造",
        agentIds: [agent.agent.id],
      })
    ).json()) as { group: { id: string } };

    // Watch the group while the draft is proposed: a card appearing is an event like any other.
    const pending = fetch(url(host, "/api/v1/chat/stream?cursor=0"));
    const deadline = Date.now() + 1_000;
    while (host.hub.subscriberCount < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await send(host, "POST", `/groups/${group.group.id}/messages`, {
      text: "登录页太麻烦了,改一下",
      mentions: [agent.agent.id],
    });

    const draftDeadline = Date.now() + 3_000;
    let draft: Message | undefined;
    for (;;) {
      draft = (await timeline(host, group.group.id)).find(
        (message) => message.kind === "task_draft",
      );
      if (draft !== undefined || Date.now() > draftDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(draft).toBeDefined();
    // The board's tools reached the model: registered is not enough, because the session's tool
    // set is pinned and the runner offers the model *that*. What matters is what the provider was
    // handed, so that is what is asserted.
    const offered = (models.calls[0]?.context.tools ?? []).map(
      (tool) => tool.name,
    );
    for (const tool of [
      "draft_task",
      "list_tasks",
      "get_task",
      "create_task",
      "update_task",
      "comment_task",
    ]) {
      expect(offered, tool).toContain(tool);
    }
    // A proposal is not work: the board is still empty, and the message says what was proposed.
    expect((await board(host)).tasks).toEqual([]);
    expect(draft?.data.title).toBe("把登录页改成邮箱登录");
    expect(String(draft?.data.description)).toContain("## 验收标准");
    expect(String(draft?.data.description)).toContain("来源：群《登录改造》");

    // Confirming it is what makes a task, and the message it was becomes the card.
    const confirmed = (await (
      await send(
        host,
        "POST",
        `/api/v1/groups/${group.group.id}/drafts/${draft!.id}/confirm`,
        { title: "把登录页改成邮箱登录", description: "用户改过的正文" },
      )
    ).json()) as TaskDetail;
    expect(confirmed).toMatchObject({
      number: 1,
      status: "todo",
      group_id: group.group.id,
    });
    const card = (await timeline(host, group.group.id)).find(
      (message) => message.id === draft!.id,
    );
    expect(card?.kind).toBe("task_card");
    expect(card?.data).toMatchObject({
      task_id: confirmed.id,
      number: 1,
      title: "把登录页改成邮箱登录",
      status: "todo",
      comments: 0,
    });

    // Confirming twice is one task: the card already carries the id.
    const again = (await (
      await send(
        host,
        "POST",
        `/api/v1/groups/${group.group.id}/drafts/${draft!.id}/confirm`,
        {
          title: "把登录页改成邮箱登录",
        },
      )
    ).json()) as TaskDetail;
    expect(again.id).toBe(confirmed.id);
    expect((await board(host)).tasks).toHaveLength(1);

    // A change to the task reaches the card, in place: same message, higher revision.
    await send(host, "PATCH", `/api/v1/tasks/${confirmed.id}`, {
      status: "in_progress",
    });
    await send(host, "POST", `/api/v1/tasks/${confirmed.id}/comments`, {
      body: "在做了",
    });
    const synced = (await timeline(host, group.group.id)).find(
      (message) => message.id === draft!.id,
    );
    expect(synced?.data.status).toBe("in_progress");
    expect(synced?.data.comments).toBe(1);
    expect(synced?.data.summary).toBe("在做了");
    expect(synced!.revision).toBeGreaterThan(card!.revision);

    // Deleting the task leaves the card, saying it is gone rather than pointing at nothing.
    await send(host, "DELETE", `/api/v1/tasks/${confirmed.id}`);
    const after = (await timeline(host, group.group.id)).find(
      (message) => message.id === draft!.id,
    );
    expect(after?.data.deleted).toBe(true);

    // And a client that was watching heard the card as it happened.
    const reader = sseReader(await pending);
    const frames = await reader.until(
      (seen) =>
        seen.some(
          (frame) =>
            frame.event === "message.updated" &&
            (frame.data as { message?: Message }).message?.id === draft!.id &&
            (frame.data as { message?: Message }).message?.kind === "task_card",
        ),
      2_000,
    );
    await reader.cancel();
    expect(frames.length).toBeGreaterThan(0);
  });
});
