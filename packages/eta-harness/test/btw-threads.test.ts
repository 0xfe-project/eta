import type { BtwSideAsk } from "../src/btw";
/**
 * Side threads (B1b, eta-agent's BtwManager).
 *
 * The panel beside the run: several questions asked while the agent works, what
 * came back, which answers took tools to reach, and what happens when someone
 * decides a tangent is worth keeping. Two properties decide whether this is
 * honest:
 *
 * - the main transcript is untouched by any of it — a side thread that leaked into
 *   the run would change what the agent is doing, which is the one thing a tangent
 *   must never do;
 * - a saved note is durable, and a failed question leaves nothing behind that could
 *   later replay as something the model said.
 */
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { BtwManager } from "../src/btw";
import { openSession } from "../src/open";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

function manager(options: { ask?: BtwSideAsk; notes?: string[] } = {}) {
  const notes = options.notes ?? [];
  const events: string[] = [];
  const btw = new BtwManager({
    buildContext: (entries) => ({
      messages: entries.flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      ),
    }),
    onVisibleNote: (note) => {
      notes.push(note);
    },
    observe: (name) => {
      events.push(name);
    },
    ...(options.ask === undefined ? {} : { sideAsk: options.ask }),
  });
  return { btw, notes, events };
}

describe("threads beside the run", () => {
  it("holds several exchanges in one thread, and answers with the tools it used", async () => {
    const asked: string[] = [];
    const { btw, events } = manager({
      ask: async (request) => {
        asked.push(request.question);
        return {
          text: `answer to ${request.question}`,
          usage: { totalTokens: 1 } as never,
          steps: [],
        };
      },
    });
    const thread = btw.create("tangent");
    await btw.ask(thread.id, "first");
    await btw.ask(thread.id, "second");

    expect(
      btw.get(thread.id)?.exchanges.map((exchange) => exchange.question),
    ).toEqual(["first", "second"]);
    expect(btw.get(thread.id)?.exchanges[0]?.answer).toBe("answer to first");
    expect(btw.get(thread.id)?.pending).toBeUndefined();
    expect(asked).toEqual(["first", "second"]);
    expect(events).toEqual([
      "btw:opened",
      "btw:asking",
      "btw:injected",
      "btw:asking",
      "btw:injected",
    ]);

    // A thread with tools records them, so an answer can be read against its work.
    btw.answer(thread.id, "third", "looked it up", [
      { tool: "read", ok: true, at: 1 },
    ]);
    expect(btw.get(thread.id)?.exchanges[2]?.steps).toEqual([
      { tool: "read", ok: true, at: 1 },
    ]);
  });

  it("keeps several threads apart, including one asked while another is in flight", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { btw } = manager({
      ask: async (request) => {
        if (request.question === "slow") await gate;
        return {
          text: `answered ${request.question}`,
          usage: { totalTokens: 1 } as never,
          steps: [],
        };
      },
    });
    const first = btw.create("tangent");
    const second = btw.create("contextual");
    const slow = btw.ask(first.id, "slow");
    await btw.ask(second.id, "quick");

    // The second thread answered while the first was still pending: a side
    // question never has to wait for another one.
    expect(btw.get(first.id)?.pending?.question).toBe("slow");
    expect(btw.get(second.id)?.exchanges[0]?.answer).toBe("answered quick");
    release();
    await slow;
    expect(btw.get(first.id)?.exchanges[0]?.answer).toBe("answered slow");
    expect(btw.list().map((thread) => thread.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("leaves no exchange behind when a side request fails", async () => {
    const { btw, events } = manager({
      ask: async () => {
        throw new Error("the side model refused");
      },
    });
    const thread = btw.create("tangent");
    await btw.ask(thread.id, "will this work?");
    const after = btw.get(thread.id);
    expect(after?.exchanges).toEqual([]);
    expect(after?.error).toContain("the side model refused");
    expect(after?.pending).toBeUndefined();
    expect(events).toEqual(["btw:opened", "btw:asking", "btw:failed"]);

    // A thread with no side model fails the same way, and says why.
    const bare = manager().btw;
    const other = bare.create("tangent");
    await bare.ask(other.id, "anyone there?");
    expect(bare.get(other.id)?.error).toBe(
      "no side model configured for this session",
    );
  });

  it("seeds a contextual thread from the message entries, not from the notes", () => {
    const { btw } = manager();
    const contextual = btw.create("contextual");
    const tangent = btw.create("tangent");
    btw.seedFrom(
      contextual.id,
      [{ type: "message", message: userMsg("the run's question") } as never],
      null,
    );
    btw.seedFrom(
      tangent.id,
      [{ type: "message", message: userMsg("ignored") } as never],
      null,
    );

    expect(btw.messagesFor(contextual.id)).toEqual([
      userMsg("the run's question"),
    ]);
    // A tangent asks with nothing inherited: it is the question, not the context.
    expect(btw.messagesFor(tangent.id)).toEqual([]);

    // What the side request sends is the seed plus the thread's own notes inline.
    btw.answer(contextual.id, "and this?", "yes");
    const messages = btw.messagesFor(contextual.id);
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages[1])).toContain("and this?");
    expect(JSON.stringify(messages[2])).toContain("yes");
  });
});

describe("saving a thread's notes", () => {
  it("writes them as notes, queueing while the run is busy", async () => {
    const { btw, notes, events } = manager();
    const thread = btw.create("tangent");
    btw.answer(thread.id, "why is this slow?", "the index is missing");

    // Busy: the note waits, because injecting mid-run would steer it.
    expect(await btw.save(thread.id, true)).toBe("queued");
    expect(notes).toEqual([]);
    // Two flushes racing at a run boundary still write each note once.
    expect(btw.flushQueued()).resolves.toBe(1);
    await btw.flushQueued();
    expect(notes).toEqual([
      "btw btw-1: why is this slow? -> the index is missing",
    ]);
    expect(btw.get(thread.id)?.saveState).toBe("saved");
    expect(events.at(-1)).toBe("btw:saved");

    // Idle: it goes straight out.
    const second = btw.create("tangent");
    btw.answer(second.id, "anything else?");
    await btw.save(second.id, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notes).toEqual([
      "btw btw-1: why is this slow? -> the index is missing",
      "btw btw-2: anything else?",
    ]);
  });

  it("hands the run a follow-up that carries the thread", () => {
    const { btw, events } = manager();
    const thread = btw.create("tangent");
    expect(btw.handoff(thread.id)).toBeUndefined();
    btw.answer(thread.id, "what about the cache?", "it is warm");
    const text = btw.handoff(thread.id);
    expect(text).toContain("[btw btw-1]");
    expect(text).toContain("what about the cache? -> it is warm");
    expect(events.at(-1)).toBe("btw:summarized");
  });

  it("forgets a cleared thread but keeps what it already wrote", async () => {
    const { btw, notes } = manager();
    const thread = btw.create("tangent");
    btw.answer(thread.id, "a question", "an answer");
    await btw.save(thread.id, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(btw.clear(thread.id)).toBe(true);
    expect(btw.clear(thread.id)).toBe(false);
    expect(btw.list()).toEqual([]);
    expect(notes).toEqual(["btw btw-1: a question -> an answer"]);
  });
});

describe("through a real session", () => {
  it("keeps side messages out of the transcript, and puts saved notes in the journal", async () => {
    const storage = new MemoryStorage();
    const session = await openSession({
      storage,
      models: fakeModels([
        assistantMessage({
          content: [{ type: "text", text: "the main answer" }],
        }),
      ]) as never,
    });
    session.kernel.inject(userMsg("the main question"));
    await session.runner.run();
    const before = session.log.transcript().length;
    expect(before).toBe(2);

    const thread = session.btw.create("tangent");
    // A side answer arrives as a note; the exchange's messages are replayed to the
    // side request and nowhere else.
    session.btw.answer(thread.id, "what is this?", "a side answer");
    expect(session.log.transcript()).toHaveLength(before);
    expect(JSON.stringify(session.log.transcript())).not.toContain(
      "a side answer",
    );

    await session.btw.save(thread.id, false);
    await session.journaling.flush();
    const entries = await storage.scanEntries({});
    const btwEntries = entries.filter((entry) => entry.type === "btw");
    expect(btwEntries).toHaveLength(1);
    expect(JSON.stringify(btwEntries[0])).toContain("a side answer");
    // The transcript is still exactly the run's two messages.
    expect(session.log.transcript()).toHaveLength(before);
    await session.kernel.dispose();
    session.stop();
  });

  it("replays threads out of the journal when the session is opened again", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    const thread = first.btw.create("tangent");
    first.btw.answer(thread.id, "remember this?", "yes: POMELO");
    await first.btw.save(thread.id, false);
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    // A restart: a fresh session over the same journal still knows the note.
    const reopened = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    const threads = reopened.btw.list();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.saveState).toBe("saved");
    const stored = await storage.scanEntries({});
    expect(JSON.stringify(stored)).toContain("POMELO");
    await reopened.kernel.dispose();
    reopened.stop();
  });

  it("answers a question through the session's own model and records what it spent", async () => {
    const storage = new MemoryStorage();
    const session = await openSession({
      storage,
      models: fakeModels([
        assistantMessage({
          content: [{ type: "text", text: "the side answer" }],
          stopReason: "stop",
        }),
      ]) as never,
      // The side request needs a run's request state, which is built from a
      // runner: the same one the session hands out.
      runner: {},
    });
    const thread = session.btw.create("tangent");
    await session.btw.ask(thread.id, "quick question?");
    expect(session.btw.get(thread.id)?.exchanges[0]?.answer).toContain(
      "the side answer",
    );

    // The spend rides in the usage rows, tagged so a panel can tell it apart.
    await session.journaling.flush();
    const rows = await storage.scanUsage({});
    expect(rows.length).toBeGreaterThan(0);
    await session.kernel.dispose();
    session.stop();
  });
});
