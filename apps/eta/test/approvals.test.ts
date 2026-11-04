/**
 * The approval list through a real socket: a tool the user listed asks before it runs and is
 * blocked on a refusal, one that is not listed never asks, and the list is the user's to change at
 * any time.
 */
import type {
  ApprovalList,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INBOX_ACTIONS } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A model that runs `bash` (touching the file the message names) and says what came back. */
const touching = () =>
  scriptedModels((request) => {
    if (request.lastRole === "toolResult")
      return say(`The tool said: ${request.last}`);
    const file = /touch (\w+)/.exec(request.last)?.[1] ?? "marker";
    return call("bash", { command: `touch ${file}` }, `call-${file}`);
  });

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

// TOBEREFR: see packages/TOBEREFR/TODO.md
describe.skip("a tool on the approval list", () => {
  it("asks before it runs, and runs when the user allows it", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["bash"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    expect(question).toMatchObject({
      questionId: "call-marker",
      options: ["allow", "deny"],
      conversationId: group.id,
      replyId: sent.replies[0]!.id,
    });
    expect(question.prompt).toContain("`bash`");
    expect(question.prompt).toContain("touch marker");
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
    await setApprovals(w, ["bash"]);

    const sent = await w.send(group.id, "please touch marker");
    const question = await pending(w);
    await answer(w, question.id, { kind: "selection", selections: ["deny"] });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("did not approve `bash`");
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
    await setApprovals(w, ["bash"]);

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
    await setApprovals(w, ["bash"]);
    const sent = await w.send(group.id, "please touch marker");
    await answer(w, (await pending(w)).id, {
      kind: "freeform",
      text: " allow ",
    });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(existsSync(join(project.path, "marker"))).toBe(true);
  });
});

// TOBEREFR: see packages/TOBEREFR/TODO.md
describe.skip("a tool that is not on the list", () => {
  it("never asks", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);
    await setApprovals(w, ["write"]);
    const sent = await w.send(group.id, "please touch marker");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(existsSync(join(project.path, "marker"))).toBe(true);
    expect(rows(w)).toEqual([]);
  });
});

describe("the list", () => {
  // TOBEREFR: see packages/TOBEREFR/TODO.md
  it.skip("applies to a session that is already open, and stops applying when it is emptied", async () => {
    const { models } = touching();
    const w = await world({ models });
    const { project, group } = await ada(w);

    // The session opens with nothing listed, and bash just runs.
    const first = await w.send(group.id, "please touch one");
    await w.settled(group.id, first.replies[0]!.id);
    expect(existsSync(join(project.path, "one"))).toBe(true);

    await setApprovals(w, ["bash"]);
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
