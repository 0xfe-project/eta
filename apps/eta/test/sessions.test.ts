import type { Host } from "../src/host";
/**
 * Sessions over HTTP (REFACTOR.md §9, P0.7).
 *
 * The whole chain, with a scripted model so it is the *host* under test rather than a provider:
 * create a session, say something, read the transcript back, run a tool, and — the claim that
 * matters — restart the process and find the history still there. A session is a journal on
 * disk, so "the process died" is not a special case: it is the case the store exists for.
 *
 * A real model runs through the same endpoints in the curl chain that closed this step.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-sessions-"));
  roots.push(root);
  return root;
}

async function start(
  dataDir: string,
  script: ReturnType<typeof assistantMessage>[],
): Promise<Host> {
  const host = await assembleHost({
    dataDir,
    port: 0,
    warn: () => undefined,
    models: fakeModels(script),
  });
  hosts.push(host);
  return host;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const post = (host: Host, path: string, body: unknown): Promise<Response> =>
  fetch(url(host, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function newSession(host: Host, body: unknown = {}): Promise<string> {
  const response = await post(host, "/sessions", body);
  expect(response.status).toBe(201);
  const created = (await response.json()) as { meta: { id: string } };
  return created.meta.id;
}

async function messagesOf(
  host: Host,
  id: string,
): Promise<{ role: string; text: string }[]> {
  const response = await fetch(url(host, `/sessions/${id}/messages`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    messages: { role: string; text: string }[];
  };
  return body.messages;
}

describe("the session chain", () => {
  it("creates a session, answers a prompt, and keeps the transcript", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir, [
      assistantMessage({
        content: [{ type: "text", text: "hello from the fake" }],
      }),
    ]);

    const id = await newSession(host, { title: "first" });
    expect(host.store).toBeDefined();

    const answered = await post(host, `/sessions/${id}/prompt`, {
      text: "say hi",
    });
    expect(answered.status).toBe(200);
    const turn = (await answered.json()) as {
      status: string;
      turns: number;
      text: string;
    };
    expect(turn.status).toBe("completed");
    expect(turn.turns).toBe(1);
    expect(turn.text).toBe("hello from the fake");

    const messages = await messagesOf(host, id);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[0]?.text).toBe("say hi");
    expect(messages[1]?.text).toBe("hello from the fake");

    // It is in the listing too, and the listing came from the store, not from what is open.
    const listed = (await (await fetch(url(host, "/sessions"))).json()) as {
      sessions: { id: string; meta?: { title?: string } }[];
    };
    expect(listed.sessions.map((session) => session.id)).toEqual([id]);
  });

  it("runs a tool: the model asks for bash, the environment answers", async () => {
    const dataDir = await scratch();
    const host = await start(dataDir, [
      assistantMessage({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      }),
      assistantMessage({
        content: [{ type: "text", text: "the command said hi" }],
      }),
    ]);

    const id = await newSession(host);
    const answered = await post(host, `/sessions/${id}/prompt`, {
      text: "run echo hi",
    });
    expect(answered.status).toBe(200);
    const turn = (await answered.json()) as { text: string };
    expect(turn.text).toBe("the command said hi");

    // The tool result is in the transcript, which is what "the tool actually ran" means.
    const messages = await messagesOf(host, id);
    const toolResult = messages.find(
      (message) => message.role === "toolResult",
    );
    expect(toolResult?.text).toContain("hi");
  });

  it("survives a restart: the journal is the session", async () => {
    const dataDir = await scratch();
    const first = await start(dataDir, [
      assistantMessage({
        content: [{ type: "text", text: "before the restart" }],
      }),
    ]);
    const id = await newSession(first);
    await post(first, `/sessions/${id}/prompt`, { text: "remember this" });
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    // A new process, the same data directory: no state was carried over in memory.
    const second = await start(dataDir, []);
    const messages = await messagesOf(second, id);
    expect(messages.map((message) => message.text)).toEqual([
      "remember this",
      "before the restart",
    ]);
  });

  it("answers 404 for a session that does not exist, and takes an abort either way", async () => {
    const host = await start(await scratch(), []);
    const missing = await post(host, "/sessions/nope/prompt", {
      text: "hello",
    });
    expect(missing.status).toBe(404);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("NO_SUCH_SESSION");

    const id = await newSession(host);
    // Nothing is running, so there is nothing to stop — and that is not an error.
    const aborted = await post(host, `/sessions/${id}/abort`, {});
    expect(aborted.status).toBe(200);
    expect(await aborted.json()).toEqual({ aborted: true });
  });

  it("refuses a prompt with no text", async () => {
    const host = await start(await scratch(), []);
    const id = await newSession(host);
    const response = await post(host, `/sessions/${id}/prompt`, {});
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("NO_TEXT");
  });
});
