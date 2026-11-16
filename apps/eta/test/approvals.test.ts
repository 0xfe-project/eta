/**
 * The approval list through a real socket: a tool the user listed asks before it runs and is
 * blocked on a refusal, one that is not listed never asks, and the list is the user's to change at
 * any time. The model writes scripts (`esmrun`), so what the list catches is what a script reaches
 * in the realm: a shell command as `shell`, a file write as `fs.write`, an MCP tool as
 * `mcp.<server>.<tool>`.
 */
import type {
  ApprovalList,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { INBOX_ACTIONS } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A model that runs one script and says what came back. */
const scripting = (script: (message: string) => string) =>
  scriptedModels((request) => {
    if (request.lastRole === "toolResult")
      return say(`The tool said: ${request.last}`);
    const file = /touch (\w+)/.exec(request.last)?.[1] ?? "marker";
    return call("esmrun", { script: script(request.last) }, `call-${file}`);
  });

/** Touches the file the message names with the shell (`touch marker`). */
const touching = () =>
  scripting((message) => {
    const file = /touch (\w+)/.exec(message)?.[1] ?? "marker";
    return `await $\`touch ${file}\`;\n"touched"`;
  });

/** Writes the file the message names with `node:fs/promises`. */
const writing = () =>
  scripting((message) => {
    const file = /touch (\w+)/.exec(message)?.[1] ?? "marker";
    return `import { writeFile } from "node:fs/promises";\nawait writeFile("${file}", "x");\n"written"`;
  });

/** The fake MCP server on stdio, in the project's `.mcp.json` as `fake`. */
const FAKE_MCP = join(
  import.meta.dirname,
  "..",
  "..",
  "daemon",
  "test",
  "fixtures",
  "fake-mcp-stdio.ts",
);
async function fakeMcp(
  projectPath: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(projectPath, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fake: {
          type: "stdio",
          command: process.execPath,
          args: [FAKE_MCP],
          ...extra,
        },
      },
    }),
  );
}

async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  w.client.subscribe("inbox");
  return { agent, project, group };
}

const rows = (w: World): InteractionView[] =>
  w.client.section<InteractionView[]>("inbox", "list") ?? [];

const approvals = (w: World): string[] =>
  w.client.section<ApprovalList>("inbox", "approvals")?.tools ?? [];

const setApprovals = async (w: World, tools: string[]) =>
  (await w.client.call("inbox", "setApprovals", { tools })) as {
    approvals: ApprovalList;
  };

const answer = (w: World, id: string, response: InboxResponse) =>
  w.client.call("inbox", "answer", { id, response });

async function pending(w: World): Promise<InteractionView> {
  await until(() => rows(w).some((row) => row.status === "pending"));
  return rows(w).find((row) => row.status === "pending")!;
}

describe("a tool on the approval list", () => {
  it("asks before it runs, and runs when the user allows it", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["shell"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    expect(question).toMatchObject({
      questionId: "approval:call-marker.shell.1",
      options: ["allow", "deny"],
      conversationId: group.id,
      replyId: sent.replies[0]!.id,
    });
    expect(question.prompt).toBe("Approve running shell?\ntouch marker");
    // The reply waits for the user, and the tool has not run.
    await w.settled(group.id, sent.replies[0]!.id, ["waiting_for_input"]);
    expect(existsSync(join(project.path, "marker"))).toBe(false);

    await answer(w, question.id, { kind: "selection", selections: ["allow"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(existsSync(join(project.path, "marker"))).toBe(true);
  });

  it("is blocked when the user denies it, and the model is told", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["shell"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    await answer(w, question.id, { kind: "selection", selections: ["deny"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain(
      "shell was refused: The user did not approve shell.",
    );
    expect(existsSync(join(project.path, "marker"))).toBe(false);
    expect(rows(w)[0]).toMatchObject({
      status: "answered",
      answer: { kind: "selection", selections: ["deny"] },
    });
  });

  it("is blocked when the user declines to answer, and when the run is stopped", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["shell"]);

    const first = await w.send(group.id, "please touch one");
    await answer(w, (await pending(w)).id, { kind: "none" });
    const done = await w.settled(group.id, first.replies[0]!.id);
    expect(done.text).toContain("did not approve");
    expect(rows(w)[0]!.status).toBe("canceled");

    const second = await w.send(group.id, "please touch two");
    await until(() => rows(w).some((row) => row.status === "pending"));
    await w.client.call("conversations", "stop", { conversationId: group.id });
    const stopped = await w.settled(group.id, second.replies[0]!.id);
    expect(stopped.status).toBe("stopped");
    await until(() => rows(w).every((row) => row.status === "canceled"));
    expect(existsSync(join(project.path, "one"))).toBe(false);
    expect(existsSync(join(project.path, "two"))).toBe(false);
  });

  it("takes the word allow typed as an answer", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["shell"]);
    const sent = await w.send(group.id, "please touch marker");
    await answer(w, (await pending(w)).id, {
      kind: "freeform",
      text: " allow ",
    });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(existsSync(join(project.path, "marker"))).toBe(true);
  });

  it("covers every file write as fs.write", async () => {
    const { models } = writing();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["fs.write"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    expect(question.prompt).toBe("Approve running fs.writeFile?\nmarker");
    expect(existsSync(join(project.path, "marker"))).toBe(false);
    await answer(w, question.id, { kind: "selection", selections: ["deny"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain(
      "fs.writeFile was refused: The user did not approve fs.writeFile.",
    );
    expect(existsSync(join(project.path, "marker"))).toBe(false);
  });

  it("refuses a listed synchronous write, which cannot wait for an answer", async () => {
    const { models } = scripting(
      () =>
        `import { writeFileSync } from "node:fs";\nwriteFileSync("marker", "x");\n"written"`,
    );
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["fs.write"]);

    const sent = await w.send(group.id, "please touch marker");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("cannot wait for the answer");
    expect(existsSync(join(project.path, "marker"))).toBe(false);
    expect(rows(w)).toEqual([]);
  });

  it("asks before an MCP tool runs, by its server and name", async () => {
    const { models } = scripting(
      () => `import fake from "mcp:fake";\nawait fake.echo({ text: "hello" })`,
    );
    const w = await world({ models });
    const { project, group } = await ada(w);
    await fakeMcp(project.path);
    await setApprovals(w, ["mcp.fake.*"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    expect(question.prompt).toBe(
      'Approve running mcp.fake.echo?\n{"text":"hello"}',
    );
    await answer(w, question.id, { kind: "selection", selections: ["deny"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain(
      "mcp.fake.echo was refused: The user did not approve mcp.fake.echo.",
    );

    const again = await w.send(group.id, "please touch other");
    await until(() => rows(w).some((row) => row.status === "pending"));
    const second = rows(w).find((row) => row.status === "pending")!;
    await answer(w, second.id, { kind: "selection", selections: ["allow"] });
    const allowed = await w.settled(group.id, again.replies[0]!.id);
    expect(allowed.text).toContain("The tool said: hello");
  });
});

describe("an MCP server's approveTools", () => {
  it("asks on the same card, with nothing on the list", async () => {
    const { models } = scripting(
      () => `import fake from "mcp:fake";\nawait fake.echo({ text: "hi" })`,
    );
    const w = await world({ models });
    const { project, group } = await ada(w);
    await fakeMcp(project.path, { approveTools: ["echo"] });

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    expect(question).toMatchObject({
      prompt: 'Approve running mcp.fake.echo?\n{"text":"hi"}',
      options: ["allow", "deny"],
    });
    await answer(w, question.id, { kind: "selection", selections: ["allow"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("The tool said: hi");
  });
});

describe("a tool that is not on the list", () => {
  it("never asks", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["fs.write", "mcp.fake.*"]);
    const sent = await w.send(group.id, "please touch marker");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(existsSync(join(project.path, "marker"))).toBe(true);
    expect(rows(w)).toEqual([]);
  });
});

describe("the list", () => {
  it("applies to a session that is already open, and stops applying when it is emptied", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);

    // The session opens with nothing listed, and the shell just runs.
    const first = await w.send(group.id, "please touch one");
    await w.settled(group.id, first.replies[0]!.id);
    expect(existsSync(join(project.path, "one"))).toBe(true);

    await setApprovals(w, ["shell"]);
    const second = await w.send(group.id, "please touch two");
    const question = await pending(w);
    expect(existsSync(join(project.path, "two"))).toBe(false);
    await answer(w, question.id, { kind: "selection", selections: ["allow"] });
    await w.settled(group.id, second.replies[0]!.id);
    expect(existsSync(join(project.path, "two"))).toBe(true);

    await setApprovals(w, []);
    const third = await w.send(group.id, "please touch three");
    await w.settled(group.id, third.replies[0]!.id);
    expect(existsSync(join(project.path, "three"))).toBe(true);
    expect(rows(w)).toHaveLength(1);
  });

  it("is on the pipe: its action, a section in hello, tidied names, and it survives a restart", async () => {
    const dataDir = await tempDir();
    const first = await world({ dataDir });
    const hello = await first.client.hello();
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(INBOX_ACTIONS.map((action) => `inbox.${action}`)),
    );
    expect(hello.state.inbox?.sections.approvals).toEqual({ tools: [] });

    first.client.subscribe("inbox");
    const result = await setApprovals(first, [" write ", "bash", "", "bash"]);
    expect(result.approvals).toEqual({ tools: ["bash", "write"] });
    await until(() => approvals(first).length === 2);
    expect(approvals(first)).toEqual(["bash", "write"]);

    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);
    const restarted = await world({ dataDir: copy });
    expect(
      (await restarted.client.hello()).state.inbox?.sections.approvals,
    ).toEqual({ tools: ["bash", "write"] });
  });

  it("is replaced only by a list", async () => {
    const w = await world();
    await setApprovals(w, ["bash"]);
    for (const args of [
      undefined,
      {},
      { tools: "bash" },
      { tools: [1] },
      { tools: ["x".repeat(201)] },
      { tools: Array.from({ length: 201 }, (_, i) => `tool-${i}`) },
    ]) {
      await expect(
        w.client.call("inbox", "setApprovals", args),
      ).rejects.toThrow();
    }
    // None of that changed the list.
    w.client.subscribe("inbox");
    await until(() => approvals(w).length > 0);
    expect(approvals(w)).toEqual(["bash"]);
  });
});
