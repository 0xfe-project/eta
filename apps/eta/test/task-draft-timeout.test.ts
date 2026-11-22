/**
 * A task draft nobody answered: past the user's limit the host confirms it as it stands or discards
 * it, as the setting says, and says on the result that it was the host. Off, nothing moves.
 */
import type { TaskBoardSettings } from "@eta/client-contracts";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { SettingStore } from "../src/settings/store";
import { TaskDraftExpirer } from "../src/tasks/draft-timeout";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const MINUTE = 60 * 1000;

const told = (w: World, id: string) =>
  w.host.db
    .query<{ text: string; data: string }, []>(
      "SELECT text, data FROM message WHERE kind = 'system' ORDER BY rowid",
    )
    .all()
    .filter(
      (row) =>
        JSON.parse(row.data).event === "task_draft_decided" &&
        JSON.parse(row.data).draftId === id,
    );

async function drafted() {
  const { models } = scriptedModels((request) =>
    request.lastRole === "toolResult"
      ? say("Drafted.")
      : call("draft_task", {
          title: "Fix login",
          goal: "Users can sign in again",
          decided: "Keep the existing form",
          acceptance: "The sign-in test passes",
        }),
  );
  const w = await world({ models, tasks: { runs: false } });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id], "login");
  await w.watch(group.id);
  const sent = await w.send(group.id, "we should fix login");
  await w.settled(group.id, sent.replies[0]!.id);
  const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
  const warnings: string[] = [];
  /** A look at the board at `later` minutes after the draft was written. */
  const sweep = (later: number) =>
    new TaskDraftExpirer({
      board: w.host.product.board,
      settings: new SettingStore(w.host.db),
      timer: false,
      now: () => draft.createdAt + later * MINUTE,
      warn: (message) => warnings.push(message),
    }).sweep();
  return { w, group, draft, sweep, warnings };
}

const configure = (w: World, draftTimeout: Record<string, unknown>) =>
  w.client.call("tasks", "setSettings", { draftTimeout }) as Promise<{
    settings: TaskBoardSettings;
  }>;

/** The draft's row as the database has it now (the client's mirror lags a write). */
const rowOf = (w: World, id: string) => {
  const row = w.host.db
    .query<{ kind: string; data: string }, [string]>(
      "SELECT kind, data FROM message WHERE id = ?",
    )
    .get(id)!;
  return {
    kind: row.kind,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
};

const count = (w: World, table: "task" | "task_activity"): number =>
  w.host.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
    .get()!.n;

describe("the draft timeout setting", () => {
  it("is off, 10 minutes, discard unless set; each part is kept alone", async () => {
    const { w } = await drafted();
    const read = async () =>
      (
        (await w.client.call("tasks", "setSettings", {})) as {
          settings: TaskBoardSettings;
        }
      ).settings.draftTimeout;
    expect(await read()).toEqual({
      enabled: false,
      minutes: 10,
      action: "discard",
    });
    await configure(w, { enabled: true });
    await configure(w, { minutes: 45 });
    await configure(w, { action: "accept" });
    expect(await read()).toEqual({
      enabled: true,
      minutes: 45,
      action: "accept",
    });
  });

  it("refuses anything it does not offer, with the reason, and keeps what it had", async () => {
    const { w } = await drafted();
    await configure(w, { enabled: true, minutes: 20, action: "accept" });
    for (const [bad, reason] of [
      [{ minutes: 0 }, /minutes is a whole number from 1 to 1440, not 0/],
      [{ minutes: 1441 }, /from 1 to 1440, not 1441/],
      [{ minutes: 2.5 }, /from 1 to 1440, not 2.5/],
      [{ minutes: "10" }, /from 1 to 1440, not "10"/],
      [{ action: "delete" }, /action is one of accept, discard, not "delete"/],
      [{ enabled: "yes" }, /enabled is true or false, not "yes"/],
    ] as const)
      await expect(configure(w, bad)).rejects.toThrow(reason);
    await expect(
      w.client.call("tasks", "setSettings", { draftTimeout: 5 }),
    ).rejects.toThrow(/draftTimeout is an object/);
    // One bad part refuses the whole call: the good part beside it is not kept either.
    await expect(
      configure(w, { enabled: false, minutes: 0 }),
    ).rejects.toThrow();
    const kept = (await w.client.call("tasks", "setSettings", {})) as {
      settings: TaskBoardSettings;
    };
    expect(kept.settings.draftTimeout).toEqual({
      enabled: true,
      minutes: 20,
      action: "accept",
    });
  });
});

describe("a draft that waited too long", () => {
  it("is left alone before its time, and by default however long it waits", async () => {
    const { w, draft, sweep } = await drafted();
    // Off (the default): nothing moves, even a day later.
    expect(sweep(24 * 60)).toEqual([]);
    await configure(w, { enabled: true, minutes: 10, action: "accept" });
    expect(sweep(9)).toEqual([]);
    expect(rowOf(w, draft.id).kind).toBe("task_draft");
    expect(count(w, "task")).toBe(0);
  });

  it("is confirmed as it stands when the action is accept, and the task says the host did it", async () => {
    const { w, draft, sweep } = await drafted();
    await configure(w, { enabled: true, minutes: 10, action: "accept" });
    expect(sweep(10)).toEqual([draft.id]);
    expect(count(w, "task")).toBe(1);
    const card = rowOf(w, draft.id);
    expect(card.kind).toBe("task_card");
    const entries = w.host.db
      .query<
        { kind: string; actor: string; body: string | null; data: string },
        []
      >(
        "SELECT kind, actor, body, data FROM task_activity ORDER BY created_at, rowid",
      )
      .all();
    const created = entries.find((entry) => entry.kind === "created")!;
    expect(JSON.parse(created.data)).toMatchObject({
      draftId: draft.id,
      auto: "timeout",
    });
    const note = entries.find((entry) => entry.kind === "comment")!;
    expect(note.actor).toBe("system");
    expect(note.body).toMatch(/Accepted automatically.*10 minute/);
    // Idempotent: a second look finds nothing pending.
    expect(sweep(60)).toEqual([]);
    expect(count(w, "task")).toBe(1);
    const sent = told(w, draft.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Nobody decided in time.*created as task #/);
    expect(JSON.parse(sent[0]!.data)).toMatchObject({
      outcome: "created",
      decidedBy: "timeout",
    });
  });

  it("is discarded when the action is discard: no task, and the card says the host did it", async () => {
    const { w, draft, sweep } = await drafted();
    await configure(w, { enabled: true, minutes: 5, action: "discard" });
    expect(sweep(5)).toEqual([draft.id]);
    expect(count(w, "task")).toBe(0);
    expect(rowOf(w, draft.id).data).toMatchObject({
      discarded: true,
      autoHandled: "timeout",
    });
    expect(sweep(60)).toEqual([]);
    const sent = told(w, draft.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Nobody decided in time.*discarded/);
    expect(JSON.parse(sent[0]!.data)).toMatchObject({
      outcome: "discarded",
      decidedBy: "timeout",
    });
  });

  it("is skipped when a person got there first", async () => {
    const mine = await drafted();
    await configure(mine.w, { enabled: true, minutes: 1, action: "accept" });
    await mine.w.client.call("tasks", "confirmDraft", {
      conversationId: mine.group.id,
      messageId: mine.draft.id,
    });
    expect(mine.sweep(30)).toEqual([]);
    expect(count(mine.w, "task")).toBe(1);
    // Their own confirmation carries no mark of the host.
    const created = mine.w.host.db
      .query<{ data: string }, []>(
        "SELECT data FROM task_activity WHERE kind = 'created'",
      )
      .get()!;
    expect(JSON.parse(created.data).auto).toBeUndefined();

    const other = await drafted();
    await configure(other.w, { enabled: true, minutes: 1, action: "accept" });
    await other.w.client.call("tasks", "discardDraft", {
      conversationId: other.group.id,
      messageId: other.draft.id,
    });
    expect(other.sweep(30)).toEqual([]);
    expect(count(other.w, "task")).toBe(0);
    expect(rowOf(other.w, other.draft.id).data.autoHandled).toBeUndefined();
  });

  it("stays pending with the reason when the host cannot confirm it, and is not tried again", async () => {
    const { w, group, draft, sweep, warnings } = await drafted();
    // A dependency that no longer exists: the confirmation checks them again and refuses.
    w.host.db.query("UPDATE message SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...draft.data,
        dependsOn: [{ taskId: "gone", requireDone: false }],
      }),
      draft.id,
    );
    await configure(w, { enabled: true, minutes: 10, action: "accept" });
    expect(sweep(10)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(draft.id);
    const row = rowOf(w, draft.id);
    expect(row.kind).toBe("task_draft");
    expect(row.data.discarded).toBeUndefined();
    expect(typeof row.data.autoFailure).toBe("string");
    expect(count(w, "task")).toBe(0);
    // Not tried again, however many looks.
    expect(sweep(20)).toEqual([]);
    expect(warnings).toHaveLength(1);
    // A person can still decide it.
    await w.client.call("tasks", "discardDraft", {
      conversationId: group.id,
      messageId: draft.id,
    });
  });
});
