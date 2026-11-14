/**
 * The view (S16).
 *
 * The subject is that nothing here enumerates fields: sections arrive from whoever owns
 * the state, each carries its own revision, and a contribution can be withdrawn. The
 * tests use a plugin's own section as the proof that the set is open — and the four
 * properties the server's frame logic depends on: a section appears when its owner has
 * something to say, its revision moves only when its state does, a withdrawn
 * contribution leaves no trace, and a broken contribution does not take the frame down.
 */

import type { AgentMessage } from "@eta/core";
import type { ViewSources } from "../src/view";
import { Buffer } from "node:buffer";
import { kernelOn } from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import {
  builtinViewContributions,
  ViewService,
  withoutImageData,
} from "../src/view";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

describe("the container", () => {
  it("projects every contribution, with a revision each", () => {
    const service = new ViewService(new Context(), {
      core: () => ({ session: "s1", running: false }),
    });
    service.contribute({ name: "one", project: () => 1, revision: () => "a" });
    service.contribute({
      name: "two",
      project: () => ({ x: 2 }),
      revision: () => "b",
    });
    const snapshot = service.snapshot();
    // The core is a section like any other: the container knows no fields at all.
    expect(snapshot.sections.core).toEqual({ session: "s1", running: false });
    expect(snapshot.sections).toMatchObject({ one: 1, two: { x: 2 } });
    expect(snapshot.revisions).toMatchObject({ one: "a", two: "b" });
    expect(service.names()).toEqual(["core", "one", "two"]);
  });

  it("moves the core's revision as the streamed message grows", () => {
    const text = (value: string) =>
      ({
        role: "assistant",
        content: [{ type: "text", text: value }],
      }) as never;
    let streaming: ReturnType<typeof text> | undefined;
    const service = new ViewService(new Context(), {
      core: () => ({ session: "s1", running: true, streaming }),
    });
    const revision = () => service.snapshot().revisions.core;
    const idle = revision();
    streaming = text("");
    const started = revision();
    streaming = text("Hel");
    const partial = revision();
    streaming = text("Hello");
    const longer = revision();
    expect(new Set([idle, started, partial, longer]).size).toBe(4);
    // Unchanged text is an unchanged revision: nothing is re-sent for nothing.
    streaming = text("Hello");
    expect(revision()).toBe(longer);
    streaming = undefined;
    expect(revision()).toBe(idle);
  });

  it("refuses two contributions with one name, the core included", () => {
    const service = new ViewService(new Context(), {
      core: () => ({ session: "s1", running: false }),
    });
    expect(() =>
      service.contribute({
        name: "core",
        project: () => ({}),
        revision: () => "1",
      }),
    ).toThrow(/already contributed: core/);
    service.contribute({
      name: "git",
      project: () => ({}),
      revision: () => "1",
    });
    expect(() =>
      service.contribute({
        name: "git",
        project: () => ({}),
        revision: () => "2",
      }),
    ).toThrow(/already contributed: git/);
  });

  it("withdraws a contribution without touching its neighbours", () => {
    const service = new ViewService(new Context(), {
      core: () => ({ session: "s1", running: false }),
    });
    const off = service.contribute({
      name: "git",
      project: () => ({ branch: "main" }),
      revision: () => "main",
    });
    service.contribute({
      name: "session",
      project: () => "core",
      revision: () => "1",
    });
    off();
    const snapshot = service.snapshot();
    // The section and its revision are both gone: absence is what tells the client.
    expect(snapshot.revisions).not.toHaveProperty("git");
    expect(snapshot.sections).not.toHaveProperty("git");
    expect(snapshot.sections.session).toBe("core");
  });

  it("reports a broken contribution instead of failing the frame", () => {
    const warnings: string[] = [];
    const service = new ViewService(new Context(), {
      core: () => ({ session: "s1", running: false }),
      warn: (message) => warnings.push(message),
    });
    service.contribute({
      name: "bad",
      project: () => {
        throw new Error("plugin exploded");
      },
      revision: () => "x",
    });
    service.contribute({
      name: "good",
      project: () => "fine",
      revision: () => "1",
    });
    const snapshot = service.snapshot();
    expect(snapshot.sections.good).toBe("fine");
    expect(snapshot.sections.bad).toEqual({ error: "plugin exploded" });
    expect(warnings.join(" ")).toContain("view section bad failed");
  });
});

describe("the built-in sections a session contributes", () => {
  it("are there as soon as a session is open, with the shapes their owners promise", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([
        assistantMessage({ content: [{ type: "text", text: "hello" }] }),
      ]) as never,
      sessionId: "eta-1",
      cwd: "/work/eta",
    });
    const names = session.view.names();
    for (const expected of [
      "transcript",
      "systems",
      "thinking",
      "branch",
      "usage",
      "goal",
      "tasks",
      "model",
      "queue",
      "tools",
      "metrics",
      "personas",
      "state",
      "sideThread",
      "subagents",
    ]) {
      expect(names, `missing section: ${expected}`).toContain(expected);
    }
    // A session without an ask channel has no ask section: absence is the truth.
    expect(names).not.toContain("ask");

    const before = session.view.snapshot();
    expect((before.sections.core as { session: string }).session).toBe("eta-1");
    expect((before.sections.core as { cwd?: string }).cwd).toBe("/work/eta");
    expect((before.sections.core as { running: boolean }).running).toBe(false);
    expect(before.sections.goal).toBeUndefined();
    expect(before.sections.tasks).toEqual([]);
    // No model was configured for this session: the section says so rather than
    // pretending, which is what the composer's picker shows as "unset".
    expect(before.sections.model).toEqual({
      id: "unknown:unknown",
      thinkingLevel: "off",
    });
    expect(
      (before.sections.tools as { name: string }[]).map((tool) => tool.name),
    ).toContain("update_step");
    expect(before.sections.transcript).toEqual({ messages: [] });

    await session.kernel.dispose();
    session.stop();
  });

  it("say what the session is doing: a turn appears in the transcript, the goal in its section", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "done" }] }),
    ]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      sessionId: "eta-2",
    });
    const empty = session.view.snapshot();

    session.kernel.goal.set("finish the port");
    session.kernel.tasks.create("keep it green");
    session.kernel.inject(userMsg("go"));
    await session.runner.run();
    await session.journaling.flush();

    const after = session.view.snapshot();
    // The transcript section is the journal, and it moved.
    expect(
      (after.sections.transcript as { messages: unknown[] }).messages,
    ).toHaveLength(2);
    expect(after.revisions.transcript).not.toBe(empty.revisions.transcript);
    expect(after.sections.goal).toMatchObject({ objective: "finish the port" });
    expect((after.sections.tasks as { content: string }[])[0]?.content).toBe(
      "keep it green",
    );
    // The core is a section too, and it moves when the run starts and stops.
    expect(after.revisions).toHaveProperty("core");

    await session.kernel.dispose();
    session.stop();
  });

  it("keeps a revision still when nothing about its owner moved", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
      sessionId: "eta-3",
    });
    const once = session.view.snapshot();
    const twice = session.view.snapshot();
    for (const [name, revision] of Object.entries(once.revisions)) {
      // `metrics` is a live rate on purpose; every other section is stable when idle.
      if (name === "metrics") continue;
      expect(twice.revisions[name], `section ${name} moved while idle`).toBe(
        revision,
      );
    }
    await session.kernel.dispose();
    session.stop();
  });

  it("carries the message being streamed in the core, and drops it when it lands", async () => {
    const models = fakeModels([
      assistantMessage({ content: [{ type: "text", text: "hello" }] }),
    ]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      sessionId: "eta-4",
    });
    // What a client would have been sent at each streamed frame.
    const seen: { running: boolean; text?: string }[] = [];
    kernelOn(session.kernel.ctx)("message:update", () => {
      const core = session.view.snapshot().sections.core as {
        running: boolean;
        streaming?: { content: { text?: string }[] };
      };
      seen.push({
        running: core.running,
        text: core.streaming?.content[0]?.text,
      });
    });
    session.kernel.inject(userMsg("go"));
    await session.runner.run();
    // While the run was in flight the core carried the half-written message.
    expect(seen).toContainEqual({ running: true, text: "hello" });
    const settled = session.view.snapshot();
    expect((settled.sections.core as { running: boolean }).running).toBe(false);
    expect(
      (settled.sections.core as { streaming?: unknown }).streaming,
    ).toBeUndefined();
    await session.kernel.dispose();
    session.stop();
  });
});

describe("a plugin's section", () => {
  it("arrives as just another section, and leaves when its contribution is withdrawn", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
      sessionId: "eta-5",
    });
    const before = session.view.snapshot();
    expect(before.revisions).not.toHaveProperty("git");

    const off = session.view.contribute({
      name: "git",
      project: () => ({ branch: "main", dirty: 2 }),
      revision: () => "main|2",
    });
    const withGit = session.view.snapshot();
    expect(withGit.sections.git).toEqual({ branch: "main", dirty: 2 });
    expect(withGit.revisions.git).toBe("main|2");

    off();
    const after = session.view.snapshot();
    expect(after.revisions).not.toHaveProperty("git");
    await session.kernel.dispose();
    session.stop();
  });
});

describe("pictures in the transcript", () => {
  // 12 bytes encode to 16 characters with no padding, 11 with one "=", 10 with "==".
  const twelve = Buffer.from("0123456789ab").toString("base64");
  const eleven = Buffer.from("0123456789a").toString("base64");
  const ten = Buffer.from("0123456789").toString("base64");

  function transcriptOf(log: SessionLog) {
    const sources = {
      session: "s",
      entries: () => log.graph.pathOldestFirst(),
      entryVersion: () => log.graph.pathOldestFirst().length,
      ask: () => undefined,
    } as unknown as ViewSources;
    const transcript = builtinViewContributions(sources).find(
      (c) => c.name === "transcript",
    );
    return transcript?.project() as {
      messages: { entryId: string; message: AgentMessage }[];
    };
  }

  it("leaves the bytes out, says how many there were, and keeps the journal whole", () => {
    const log = SessionLog.create(new MemoryStorage());
    const user = log.recordMessage({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: twelve, mimeType: "image/png" },
      ],
      timestamp: 0,
    });
    const result = log.recordMessage({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "image", data: ten, mimeType: "image/jpeg" }],
      isError: false,
      timestamp: 0,
    });
    const rows = transcriptOf(log).messages;
    expect(rows.map((row) => row.entryId)).toEqual([user.id, result.id]);
    expect(
      rows.map((row) => (row.message as { content: unknown }).content),
    ).toEqual([
      [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "", bytes: 12 },
      ],
      [{ type: "image", mimeType: "image/jpeg", data: "", bytes: 10 }],
    ]);
    // The journal's own messages still hold the pictures.
    expect(user.message).toMatchObject({
      content: [
        { type: "text", text: "look" },
        { type: "image", data: twelve, mimeType: "image/png" },
      ],
    });
    expect(result.message).toMatchObject({
      content: [{ type: "image", data: ten, mimeType: "image/jpeg" }],
    });
  });

  it("hands a message without pictures through as is", () => {
    const log = SessionLog.create(new MemoryStorage());
    const plain = log.recordMessage(userMsg("just words"));
    const text = log.recordMessage({
      role: "user",
      content: "a string",
      timestamp: 0,
    });
    const [first, second] = transcriptOf(log).messages;
    expect(first?.message).toBe(plain.message);
    expect(second?.message).toBe(text.message);
  });

  it("counts the padding when it sizes a picture", () => {
    const message: AgentMessage = {
      role: "user",
      content: [
        { type: "image", data: twelve, mimeType: "image/png" },
        { type: "image", data: eleven, mimeType: "image/png" },
        { type: "image", data: ten, mimeType: "image/png" },
      ],
      timestamp: 0,
    };
    const stripped = withoutImageData(message);
    expect(stripped).not.toBe(message);
    expect(
      (stripped as { content: { bytes?: number }[] }).content.map(
        (part) => part.bytes,
      ),
    ).toEqual([12, 11, 10]);
    expect(
      (message.content as { data: string }[]).map((part) => part.data),
    ).toEqual([twelve, eleven, ten]);
  });
});
