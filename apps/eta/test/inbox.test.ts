/**
 * The inbox through a real socket: a session's question becomes a row, answering it resumes the
 * run that asked, and what became of every question stays on the list, restarts included.
 */
import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import type { AskPayload } from "@eta/core/session";
import type { SessionMeta } from "@eta/server";
import type { NewInteraction } from "../src/inbox/store";
import type { World } from "./support/world";
import { AskRegistry } from "@eta/harness";
import { describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { HISTORY_LIMIT, Inbox } from "../src/inbox/inbox";
import { SettingStore } from "../src/inbox/setting";
import { InteractionStore } from "../src/inbox/store";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** One agent who is the project's steward, and a conversation she is in. */
async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  w.client.subscribe("inbox");
  return { agent, project, group };
}

const list = (w: World): InteractionView[] =>
  w.client.section<InteractionView[]>("inbox", "list") ?? [];

/** Wait for the inbox the client holds to have a question with the status. */
async function listed(
  w: World,
  status: InteractionView["status"],
): Promise<InteractionView> {
  await until(() => list(w).some((row) => row.status === status));
  return list(w).find((row) => row.status === status)!;
}

const answer = async (
  w: World,
  id: string,
  response: InboxResponse,
): Promise<{ interaction: InteractionView; answered: boolean }> =>
  (await w.client.call("inbox", "answer", { id, response })) as {
    interaction: InteractionView;
    answered: boolean;
  };

/** A model that asks the user which colour, then repeats what it was told. */
const colours = () =>
  scriptedModels((request) =>
    request.lastRole === "toolResult"
      ? say(`Chose: ${request.last}`)
      : call(
          "ask_user",
          {
            question: "Which colour?",
            options: [{ title: "red" }, { title: "blue" }],
          },
          "q-1",
        ),
  );

describe("the inbox target", () => {
  it("is on the pipe from the start, with its actions and an empty list", async () => {
    const w = await world();
    const hello = await w.client.hello();
    expect(hello.ops.map((op) => op.name)).toEqual(
      expect.arrayContaining(["inbox.answer"]),
    );
    expect(hello.state.inbox?.sections.list).toEqual([]);
    expect(hello.mounted.map((plugin) => plugin.name)).toContain("inbox");
  });
});

describe("a question from a session", () => {
  it("becomes a pending row with whose question it is, and the answer resumes the run", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { agent, group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    const reply = sent.replies[0]!;

    const pending = await listed(w, "pending");
    expect(pending).toMatchObject({
      questionId: "q-1",
      agentId: agent.id,
      conversationId: group.id,
      replyId: reply.id,
      prompt: "Which colour?",
      options: ["red", "blue"],
      multi: false,
      status: "pending",
      answer: null,
      revision: 1,
    });
    expect(pending.sessionId).toBe(
      w.client.section<{ sessionId: string }[]>(
        `conversations.${group.id}`,
        "members",
      )![0]!.sessionId,
    );
    // The reply says it is waiting for the user, and the row is how the user finds out why.
    await w.settled(group.id, reply.id, ["waiting_for_input"]);

    const response: InboxResponse = { kind: "selection", selections: ["blue"] };
    const result = await answer(w, pending.id, response);
    expect(result.answered).toBe(true);
    expect(result.interaction).toMatchObject({
      id: pending.id,
      status: "answered",
      answer: response,
      revision: 2,
    });

    const done = await w.settled(group.id, reply.id);
    expect(done.status).toBe("done");
    expect(done.text).toContain("blue");
    const settled = await listed(w, "answered");
    expect(settled).toMatchObject({ id: pending.id, answer: response });
    expect(list(w).filter((row) => row.status === "pending")).toEqual([]);
  });

  it("takes a freeform answer, and answering twice changes nothing", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    const pending = await listed(w, "pending");

    const first = await answer(w, pending.id, {
      kind: "freeform",
      text: "teal, please",
    });
    expect(first.answered).toBe(true);
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("teal, please");

    const again = await answer(w, pending.id, {
      kind: "selection",
      selections: ["red"],
    });
    expect(again.answered).toBe(false);
    expect(again.interaction).toEqual(first.interaction);
  });

  it("declining is a cancel: the model is told nobody answered", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    const pending = await listed(w, "pending");

    const result = await answer(w, pending.id, { kind: "none" });
    expect(result.interaction).toMatchObject({
      status: "canceled",
      answer: { kind: "none" },
    });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("No answer from the user");
  });

  it("is canceled when the run is stopped under it", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "paint it");
    const pending = await listed(w, "pending");

    await w.client.call("conversations", "stop", { conversationId: group.id });
    const ended = await w.settled(group.id, sent.replies[0]!.id);
    expect(ended.status).toBe("stopped");
    const canceled = await listed(w, "canceled");
    expect(canceled).toMatchObject({ id: pending.id, answer: null });
    expect(canceled.revision).toBe(2);
    // Nothing is waiting: an answer now says so and changes nothing.
    const late = await answer(w, pending.id, {
      kind: "selection",
      selections: ["red"],
    });
    expect(late).toMatchObject({ answered: false });
    expect(late.interaction.status).toBe("canceled");
  });

  it("is settled too when the session is answered where it asked", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { group } = await ada(w);
    await w.send(group.id, "paint it");
    const pending = await listed(w, "pending");

    await w.client.call("sessions", "answer", {
      session: pending.sessionId,
      questionId: "q-1",
      response: { kind: "selection", selections: ["red"] },
    });
    // Answered, though nobody told the inbox with what.
    const settled = await listed(w, "answered");
    expect(settled).toMatchObject({ id: pending.id, answer: null });
  });

  it("is asked in more than one conversation at once, and each is answered where it belongs", async () => {
    const { models, requests } = colours();
    const w = await world({ models });
    const { agent, project, group } = await ada(w);
    const other = await w.group(project.id, [agent.id], "other");
    await w.watch(other.id);
    const one = await w.send(group.id, "paint it");
    const two = await w.send(other.id, "paint it too");
    await until(() => list(w).length === 2);
    // Two sessions drew the same question id; they are two questions.
    expect(new Set(list(w).map((row) => row.id)).size).toBe(2);
    expect(new Set(list(w).map((row) => row.conversationId))).toEqual(
      new Set([group.id, other.id]),
    );

    const second = list(w).find((row) => row.conversationId === other.id)!;
    await answer(w, second.id, { kind: "selection", selections: ["red"] });
    const done = await w.settled(other.id, two.replies[0]!.id);
    expect(done.text).toContain("red");
    expect(w.row(group.id, one.replies[0]!.id)?.status).toBe(
      "waiting_for_input",
    );
    expect(requests.length).toBeGreaterThanOrEqual(3);
    await w.client.call("conversations", "stop", { conversationId: group.id });
  });

  it("refuses an answer it cannot read, and a question it does not have", async () => {
    const { models } = colours();
    const w = await world({ models });
    const { group } = await ada(w);
    await w.send(group.id, "paint it");
    const pending = await listed(w, "pending");

    await expect(
      w.client.call("inbox", "answer", {
        id: "nope",
        response: { kind: "none" },
      }),
    ).rejects.toThrow(/no such question/);
    for (const response of [
      undefined,
      "blue",
      { kind: "maybe" },
      { kind: "selection", selections: [] },
      { kind: "selection", selections: [1] },
      { kind: "freeform", text: "  " },
      { kind: "freeform" },
    ]) {
      await expect(
        w.client.call("inbox", "answer", { id: pending.id, response }),
      ).rejects.toThrow(/inbox\.answer/);
    }
    await expect(
      w.client.call("inbox", "answer", { response: { kind: "none" } }),
    ).rejects.toThrow(/needs id/);
    // None of that touched the question.
    expect(list(w).find((row) => row.id === pending.id)?.status).toBe(
      "pending",
    );
    await w.client.call("conversations", "stop", { conversationId: group.id });
  });
});

describe("a restart", () => {
  it("ends the questions the last process left pending, as expired", async () => {
    const dataDir = await tempDir();
    const { models } = colours();
    const first = await world({ dataDir, models });
    const { group } = await ada(first);
    const sent = await first.send(group.id, "paint it");
    const pending = await listed(first, "pending");
    await first.settled(group.id, sent.replies[0]!.id, ["waiting_for_input"]);

    // The process dies without closing anything: what the next one finds is a copy of the file.
    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);
    const restarted = await world({ dataDir: copy });
    const hello = await restarted.client.hello();
    const rows = hello.state.inbox!.sections.list as InteractionView[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending.id,
      status: "expired",
      answer: null,
      revision: 2,
    });
    // And an answer to it is not an error, only too late.
    const late = await restarted.client.call("inbox", "answer", {
      id: pending.id,
      response: { kind: "selection", selections: ["red"] },
    });
    expect(late).toMatchObject({ answered: false });
  });
});

describe("retention", () => {
  it("prunes settled questions older than 30 days at startup and never a pending one", async () => {
    const DAY = 24 * 3_600_000;
    const dataDir = await tempDir();
    const first = await world({ dataDir });
    const insert = (id: string, status: string, age: number) =>
      first.host.db
        .query(
          `INSERT INTO interaction (id, session_id, question_id, prompt, status, created_at, updated_at)
           VALUES (?, 's', ?, 'p', ?, ?, ?)`,
        )
        .run(id, id, status, Date.now() - age, Date.now() - age);
    insert("old-answered", "answered", 31 * DAY);
    insert("old-expired", "expired", 40 * DAY);
    insert("fresh-answered", "answered", 29 * DAY);
    insert("old-pending", "pending", 90 * DAY);

    const copy = await tempDir();
    first.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);
    const restarted = await world({ dataDir: copy });
    const ids = restarted.host.db
      .query<{ id: string; status: string }, []>(
        "SELECT id, status FROM interaction ORDER BY id",
      )
      .all();
    // The old pending one was expired by the restart just now, so it is a fresh settled row.
    expect(ids).toEqual([
      { id: "fresh-answered", status: "answered" },
      { id: "old-pending", status: "expired" },
    ]);
  });
});

describe("the ask channel's own endings", () => {
  const meta = { id: "s1", createdAt: 0, cwd: "/tmp" } as SessionMeta;
  const payload = (questionId: string): AskPayload => ({
    questionId,
    question: "Proceed?",
    options: ["yes", "no"],
  });

  const question = (questionId: string): NewInteraction => ({
    sessionId: "s1",
    questionId,
    prompt: "Proceed?",
    options: [],
    multi: false,
    agentId: null,
    conversationId: null,
    replyId: null,
  });

  function open() {
    const db = openDatabase(":memory:");
    applyMigrations(db, loadMigrations());
    const interactions = new InteractionStore(db);
    const moved: number[] = [];
    const warned: string[] = [];
    const inbox = new Inbox({
      interactions,
      settings: new SettingStore(db),
      timeline: { active: () => [] } as never,
      changed: () => moved.push(moved.length),
      warn: (message) => warned.push(message),
    });
    const registry = new AskRegistry({ observe: inbox.askObserve(meta) });
    return { interactions, inbox, registry, moved, warned };
  }

  it("expires a question whose deadline passed", async () => {
    const { interactions, registry, moved } = open();
    const response = await registry.ask(payload("q1"), { timeoutMs: 10 });
    expect(response).toEqual({ kind: "none" });
    expect(interactions.get("s1:q1")).toMatchObject({
      status: "expired",
      revision: 2,
    });
    expect(moved).toHaveLength(2);
  });

  it("cancels a question whose run was aborted", async () => {
    const { interactions, registry } = open();
    const controller = new AbortController();
    const asked = registry.ask(payload("q1"), { signal: controller.signal });
    expect(interactions.get("s1:q1")?.status).toBe("pending");
    controller.abort();
    await asked;
    expect(interactions.get("s1:q1")?.status).toBe("canceled");
  });

  it("keeps the ending a question has, and starts over when the same one is asked again", async () => {
    const { interactions, registry } = open();
    await registry.ask(payload("q1"), { timeoutMs: 5 });
    // Settled once: another ending changes nothing.
    expect(interactions.settle("s1:q1", "canceled")).toBeUndefined();
    expect(interactions.get("s1:q1")?.status).toBe("expired");

    const again = registry.ask(payload("q1"));
    expect(interactions.get("s1:q1")).toMatchObject({
      status: "pending",
      revision: 3,
    });
    registry.answer("q1", { kind: "freeform", text: "yes" });
    await again;
    expect(interactions.get("s1:q1")?.status).toBe("answered");
  });

  it("finds the row a pending question already has instead of writing a second", () => {
    const { interactions } = open();
    const first = interactions.open(question("q1"));
    expect(interactions.open(question("q1"))).toEqual(first);
  });

  it("lists the pending first and bounds the history", () => {
    const { interactions, inbox } = open();
    for (let i = 0; i < 130; i++) {
      interactions.open(question(`done-${i}`));
      interactions.settle(`s1:done-${i}`, "answered");
    }
    interactions.open(question("waiting"));
    const rows = inbox.list();
    expect(rows[0]).toMatchObject({ questionId: "waiting", status: "pending" });
    expect(rows).toHaveLength(HISTORY_LIMIT + 1);
    expect(rows.slice(1).every((row) => row.status === "answered")).toBe(true);
  });

  it("never lets a failure to record reach the run that asked", async () => {
    const { registry, warned, interactions } = open();
    (interactions as { open: unknown }).open = () => {
      throw new Error("disk full");
    };
    const asked = registry.ask(payload("q1"), { timeoutMs: 5 });
    await expect(asked).resolves.toEqual({ kind: "none" });
    expect(warned[0]).toMatch(/disk full/);
  });
});
