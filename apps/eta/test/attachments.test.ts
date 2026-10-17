import type { Host } from "../src/host";
/**
 * Attaching a file to a message (FRONTEND_REFACTOR.md §5.2, P9).
 *
 * The claim is narrow and worth testing exactly: the bytes end up inside the group's project, the
 * answer carries a path relative to that project, and a message that references it reaches the
 * agent as text it can open. No second storage system, no id the model has to know about.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (host: Host, method: string, path: string, body?: unknown) =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

async function host(): Promise<Host> {
  const created = await assembleHost({
    dataDir: await scratch("eta-attach-"),
    port: 0,
    warn: () => undefined,
  });
  hosts.push(created);
  return created;
}

async function group(host: Host, cwd?: string): Promise<string> {
  const agent = (await (
    await send(host, "POST", "/agents", { name: "builder" })
  ).json()) as { id: string };
  const created = (await (
    await send(host, "POST", "/groups", {
      name: "app",
      ...(cwd === undefined ? {} : { cwd }),
      agentIds: [agent.id],
    })
  ).json()) as { group: { id: string } };
  return created.group.id;
}

describe("附件", () => {
  it("落在群的项目里，回答里给的是相对那个项目的路径", async () => {
    const eta = await host();
    const project = await scratch("eta-attach-project-");
    const id = await group(eta, project);
    const response = await fetch(
      url(
        eta,
        `/api/v1/groups/${id}/attachments?name=${encodeURIComponent("截图.png")}`,
      ),
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      path: string;
      name: string;
      size: number;
    };
    expect(body.name).toBe("截图.png");
    expect(body.size).toBe(4);
    expect(body.path.startsWith(".eta/uploads/")).toBe(true);

    const onDisk = await readFile(join(project, body.path));
    expect([...onDisk]).toEqual([1, 2, 3, 4]);
  });

  it("同一个名字传两次不会盖掉前一个", async () => {
    const eta = await host();
    const project = await scratch("eta-attach-project-");
    const id = await group(eta, project);
    const upload = async (text: string) => {
      // A second apart, so the sortable stamp differs.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const response = await fetch(
        url(eta, `/api/v1/groups/${id}/attachments?name=a.txt`),
        { method: "POST", body: new TextEncoder().encode(text) },
      );
      return ((await response.json()) as { path: string }).path;
    };
    const first = await upload("one");
    const second = await upload("two");
    expect(first).not.toBe(second);
    expect(await readFile(join(project, first), "utf8")).toBe("one");
    expect(await readFile(join(project, second), "utf8")).toBe("two");
  });

  it("没绑目录的群说清楚它没地方放，而不是自己编一个目录", async () => {
    const eta = await host();
    const id = await group(eta);
    const response = await fetch(
      url(eta, `/api/v1/groups/${id}/attachments?name=a.txt`),
      { method: "POST", body: new TextEncoder().encode("x") },
    );
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("NO_FOLDER");
  });

  it("带附件的消息仍然是一句话：路径被写进去，agent 能照常打开", async () => {
    const eta = await host();
    const project = await scratch("eta-attach-project-");
    const id = await group(eta, project);
    const uploaded = (await (
      await fetch(url(eta, `/api/v1/groups/${id}/attachments?name=notes.txt`), {
        method: "POST",
        body: new TextEncoder().encode("hello"),
      })
    ).json()) as { path: string; id: string; name: string; size: number };

    const sent = await send(eta, "POST", "/api/v1/chat/messages", {
      group_id: id,
      parts: [
        { type: "text", text: "看一下这个" },
        {
          type: "attachment",
          id: uploaded.id,
          part_id: uploaded.id,
          name: uploaded.name,
          content_type: "text/plain",
          size: uploaded.size,
          path: uploaded.path,
        },
      ],
    });
    // Not a refusal any more: the file is a file in the project, so the message is text.
    expect(sent.status).toBeLessThan(400);
    const statted = await stat(join(project, uploaded.path));
    expect(statted.isFile()).toBe(true);
  });
});
