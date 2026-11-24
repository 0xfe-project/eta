/**
 * Files with a task's comment: uploaded to the task the way a message's are to a conversation,
 * claimed by the comment, shown back on the timeline, and handed to the executor with the comment —
 * a picture as an image when its model takes images, else as a file it is told it was not shown,
 * which the comment then says. Real hosts, scripted models.
 */
import type { AttachmentView, BoardTaskDetail } from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A small PNG header is enough: nothing here decodes the picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

async function upload(
  w: World,
  taskId: string,
  bytes: Uint8Array,
  name = "shot.png",
  contentType = "image/png",
): Promise<AttachmentView> {
  const result = (await w.client.call("tasks", "attach", {
    taskId,
    uploadId: crypto.randomUUID(),
    name,
    contentType,
    index: 0,
    last: true,
    data: Buffer.from(bytes).toString("base64"),
  })) as { attachment: AttachmentView };
  return result.attachment;
}

async function room(
  respond: Parameters<typeof scriptedModels>[0],
  options: { vision?: boolean } = {},
) {
  const { models, requests } = scriptedModels(respond, options);
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id], "login");
  await w.watch(group.id);
  const make = (
    title: string,
    status: "todo" | "backlog" = "todo",
  ): BoardTaskDetail =>
    w.host.product.board.create(
      {
        title,
        description: `Do ${title}`,
        status,
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );
  return { w, ada, group, requests, make };
}

const statusOf = (w: World, id: string) =>
  w.host.product.board.detail(id)!.status;

const runCount = (w: World, id: string) =>
  w.host.product.board.detail(id)!.runs.length;

const settled = (w: World, id: string) =>
  w.host.product.board
    .detail(id)!
    .runs.every(
      (run) => !["queued", "starting", "running"].includes(run.status),
    );

const comments = (w: World, id: string) =>
  w.host.product.board.activity(id).filter((entry) => entry.kind === "comment");

describe("a comment's files", () => {
  it("are uploaded to the task, claimed by the comment and kept in its data", async () => {
    const r = await room(() => say("ok"));
    const task = r.make("Look", "backlog");
    const file = await upload(r.w, task.id, PNG);
    expect(file).toMatchObject({
      name: "shot.png",
      contentType: "image/png",
      size: PNG.byteLength,
    });
    expect(
      existsSync(
        join(
          r.w.host.dataDir,
          "attachments",
          `task-${task.id}`,
          `${file.id}-shot.png`,
        ),
      ),
    ).toBe(true);
    // A picture alone is a comment: no words needed.
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "",
      attachments: [file.id],
    });
    expect(comments(r.w, task.id).at(-1)!.data.attachments).toEqual([file]);
    // Shown back, by the task's call and by the same address a chat's pictures are served at.
    expect(
      await r.w.client.call("tasks", "attachment", {
        taskId: task.id,
        attachmentId: file.id,
      }),
    ).toEqual({ contentType: "image/png", data: PNG.toString("base64") });
    const served = await fetch(
      `http://127.0.0.1:${r.w.host.port}/attachments/${file.id}`,
    );
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
    // Sent once: it cannot go again, nor be taken back.
    await expect(
      r.w.client.call("tasks", "comment", {
        taskId: task.id,
        body: "again",
        attachments: [file.id],
      }),
    ).rejects.toThrow(/already sent/);
    expect(
      await r.w.client.call("tasks", "unattach", {
        taskId: task.id,
        attachmentId: file.id,
      }),
    ).toEqual({ removed: false });
  });

  it("are one task's: another task, or a conversation, cannot send them", async () => {
    const r = await room(() => say("ok"));
    const one = r.make("One", "backlog");
    const two = r.make("Two", "backlog");
    const file = await upload(r.w, one.id, PNG);
    await expect(
      r.w.client.call("tasks", "comment", {
        taskId: two.id,
        body: "mine?",
        attachments: [file.id],
      }),
    ).rejects.toThrow(/no such attachment/);
    await expect(
      r.w.send(r.group.id, "mine?", { attachments: [file.id] }),
    ).rejects.toThrow(/no such attachment/);
    await expect(
      r.w.client.call("tasks", "attachment", {
        taskId: two.id,
        attachmentId: file.id,
      }),
    ).rejects.toThrow(/no such attachment/);
    // An unsent one can be taken back, by its own task only.
    expect(
      await r.w.client.call("tasks", "unattach", {
        taskId: two.id,
        attachmentId: file.id,
      }),
    ).toEqual({ removed: false });
    expect(
      await r.w.client.call("tasks", "unattach", {
        taskId: one.id,
        attachmentId: file.id,
      }),
    ).toEqual({ removed: true });
    await expect(
      r.w.client.call("tasks", "attach", {
        taskId: crypto.randomUUID(),
        uploadId: crypto.randomUUID(),
        name: "x.png",
        index: 0,
        last: true,
        data: PNG.toString("base64"),
      }),
    ).rejects.toThrow(/no such task/);
  });

  it("go with the task when it is deleted", async () => {
    const r = await room(() => say("ok"));
    const task = r.make("Gone", "backlog");
    const file = await upload(r.w, task.id, PNG);
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "see",
      attachments: [file.id],
    });
    const folder = join(r.w.host.dataDir, "attachments", `task-${task.id}`);
    expect(existsSync(folder)).toBe(true);
    await r.w.client.call("tasks", "delete", { taskId: task.id });
    await until(() => !existsSync(folder));
    // Its row went with it: the file is not served any more.
    const served = await fetch(
      `http://127.0.0.1:${r.w.host.port}/attachments/${file.id}`,
    );
    expect(served.status).toBe(404);
  });
});

describe("a picture in a comment, to the executor", () => {
  it("goes into the run that is going as an image, with its path", async () => {
    const hold = gate();
    const r = await room(
      async (request) => {
        if (!isRun(request)) return say("ok");
        if (
          request.lastRole === "toolResult" &&
          request.last.includes("posted")
        )
          return say("finished");
        if (request.index === 0) {
          await hold.opened;
          return call("bash", { command: "echo working" });
        }
        return request.transcript.join("\n").includes("what is on it")
          ? call("finish_task", { summary: "A red square." })
          : say("nothing yet");
      },
      { vision: true },
    );
    const task = r.make("Read the picture");
    await until(() => statusOf(r.w, task.id) === "in_progress");
    const file = await upload(r.w, task.id, PNG);
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "what is on it",
      attachments: [file.id],
    });
    hold.open();
    await until(
      () => statusOf(r.w, task.id) === "in_review" && settled(r.w, task.id),
    );
    // The same run read it: the comment steered it, nothing was queued for it.
    expect(runCount(r.w, task.id)).toBe(1);
    const told = r.requests
      .filter(isRun)
      .find((request) =>
        request.transcript.join("\n").includes("what is on it"),
      )!;
    expect(told.images).toBe(1);
    expect(told.transcript.join("\n")).toContain(
      join("attachments", `task-${task.id}`, `${file.id}-shot.png`),
    );
    expect(comments(r.w, task.id)[0]!.data.imagesUnseenBy).toBeUndefined();
  });

  it("wakes the next run with the image, in the task's session", async () => {
    const r = await room(
      (request) => {
        if (!isRun(request)) return say("ok");
        if (request.lastRole === "toolResult") return say("finished");
        return request.transcript.join("\n").includes("look at this")
          ? call("finish_task", { summary: "Seen." })
          : call("finish_task", { summary: "First pass." });
      },
      { vision: true },
    );
    const task = r.make("Two passes");
    await until(
      () => statusOf(r.w, task.id) === "in_review" && settled(r.w, task.id),
    );
    const before = r.requests.length;
    const file = await upload(r.w, task.id, PNG);
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "look at this",
      attachments: [file.id],
    });
    await until(() => runCount(r.w, task.id) === 2 && settled(r.w, task.id));
    const woken = r.requests.slice(before).filter(isRun)[0]!;
    expect(woken.last).toContain("look at this");
    expect(woken.last).toContain(`${file.id}-shot.png`);
    expect(woken.images).toBe(1);
  });

  it("is a file to a model that takes no images, and the comment says it was not shown", async () => {
    const hold = gate();
    const r = await room(async (request) => {
      if (!isRun(request)) return say("ok");
      if (request.lastRole === "toolResult" && request.last.includes("posted"))
        return say("finished");
      if (request.index === 0) {
        await hold.opened;
        return call("bash", { command: "echo working" });
      }
      return request.transcript.join("\n").includes("what is on it")
        ? call("finish_task", { summary: "Cannot see it." })
        : say("nothing yet");
    });
    const task = r.make("Blind");
    await until(() => statusOf(r.w, task.id) === "in_progress");
    const file = await upload(r.w, task.id, PNG);
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "what is on it",
      attachments: [file.id],
    });
    hold.open();
    await until(
      () => statusOf(r.w, task.id) === "in_review" && settled(r.w, task.id),
    );
    const told = r.requests
      .filter(isRun)
      .find((request) =>
        request.transcript.join("\n").includes("what is on it"),
      )!;
    expect(told.images).toBe(0);
    expect(told.transcript.join("\n")).toContain(
      "not shown: the model you run on does not support images",
    );
    expect(comments(r.w, task.id)[0]!.data.imagesUnseenBy).toEqual([r.ada.id]);
  });
});
