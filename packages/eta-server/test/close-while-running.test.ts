/**
 * Closing one session while another is mid-run.
 *
 * A run is a long thing: it streams, calls tools, retries. If closing a *different*
 * session could interrupt it — or truncate its journal — the server would be
 * unusable the moment a user tidied up their sidebar.
 */
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

describe("closing one session while another runs", () => {
  it("lets the running session finish, with its journal intact", async () => {
    const store = new MemorySessionStore();
    const sessions = new SessionManager({
      store,
      // The first answer the running session will get; the second session gets
      // its own models and is never asked anything.
      modelsFor: () =>
        fakeModels([
          assistantMessage({
            content: [{ type: "text", text: "the run finished" }],
            stopReason: "stop",
          }),
        ]) as never,
    });
    const running = await sessions.create({ cwd: "/work/running" });
    const other = await sessions.create({ cwd: "/work/other" });

    // A prompt is injected, then the run adopts it: the injected message becomes
    // an entry when the run picks it up, not when it is queued.
    running.session.kernel.inject(userMsg("go"));
    const turn = running.session.runner.run();
    // The other session closes mid-run, and is asked to work while at it.
    expect(await sessions.close(other.meta.id)).toBe(true);

    const result = await turn;
    expect(result.status).toBe("completed");

    // The run's journal is complete: the user message and the answer are both there.
    const storage = (await store.open(running.meta.id))!.storage;
    const entries = await storage.scanEntries({});
    const types = entries.map((entry) => entry.type);
    expect(types).toContain("message");
    expect(JSON.stringify(entries)).toContain("the run finished");
    // Both sides of the turn are on disk: the question the run adopted, and the
    // answer it produced. (The fake provider spends no tokens, so there is no
    // measurement to assert here — the entry is the durable part.)
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).toContain("go");

    // And the closed session's own storage was left alone by any of this.
    const otherStorage = (await store.open(other.meta.id))!.storage;
    expect(await otherStorage.scanEntries({})).toEqual([]);

    await sessions.closeAll();
  });

  it("a session that was closed mid-run can be reopened and replayed afterwards", async () => {
    const store = new MemorySessionStore();
    const sessions = new SessionManager({
      store,
      modelsFor: () =>
        fakeModels([
          assistantMessage({
            content: [{ type: "text", text: "an answer" }],
            stopReason: "stop",
          }),
        ]) as never,
    });
    const session = await sessions.create({ cwd: "/work" });
    session.session.kernel.inject(userMsg("first question"));
    const turn = session.session.runner.run();
    // Closed while its own run is still in flight.
    expect(session.session.runner.running).toBe(true);
    expect(await sessions.close(session.meta.id)).toBe(true);
    await turn;

    // Open it again: the transcript comes back from the journal, not from a live
    // object, and starts with the question the run had adopted.
    const reopened = await sessions.session(session.meta.id);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(session);
    const texts = () =>
      reopened!.session.log
        .transcript()
        .map((message) => JSON.stringify(message));
    expect(texts()[0]).toContain("first question");
    expect(reopened!.meta.cwd).toBe("/work");

    // A new turn on the reopened session continues that transcript.
    const before = texts().length;
    reopened!.session.kernel.inject(userMsg("second question"));
    expect((await reopened!.session.runner.run()).status).toBe("completed");
    expect(texts().slice(before)).toEqual([
      expect.stringContaining("second question"),
      expect.stringContaining("an answer"),
    ]);
    await sessions.closeAll();
  });
});
