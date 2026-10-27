/**
 * Repairing a transcript a provider would refuse (see transcript-repair.ts).
 *
 * What is pinned here: the two halves of a broken tool call/result pair, each
 * repaired the way the rules allow — a result nobody asked for leaves the
 * branch, a call nobody answered is closed with a placeholder that says the
 * outcome is unknown — and that the repair survives a reload, because a fix
 * that only lives in memory re-breaks the session on the next open.
 */

import { Buffer } from "node:buffer";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { repairTranscript } from "../src/index";

const userText = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const resultFor = (toolCallId: string, text = "ok") => ({
  role: "toolResult" as const,
  toolCallId,
  toolName: "bash",
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: 0,
});

/** A PNG header at 1280×11024 — the picture a provider refuses. */
const tallPng = (): string => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 1280);
  view.setUint32(20, 11024);
  return Buffer.from(bytes).toString("base64");
};

const callsTo = (...ids: string[]) =>
  assistantMessage({
    content: ids.map((id) => ({
      type: "toolCall" as const,
      id,
      name: "bash",
      arguments: { command: "ls" },
    })),
  });

/** The transcript as a provider reads it: role plus, for results, what it answers. */
function shape(log: SessionLog): string[] {
  return log.transcript().map((message) => {
    if (message.role === "toolResult")
      return `toolResult:${message.toolCallId}`;
    return message.role;
  });
}

async function journal(
  ...messages: Parameters<SessionLog["recordMessage"]>[0][]
) {
  const storage = new MemoryStorage();
  const log = SessionLog.create(storage);
  for (const message of messages) log.recordMessage(message);
  await log.commit();
  return { storage, log };
}

describe("repairTranscript", () => {
  it("drops a tool result the transcript has no call for", async () => {
    const { storage, log } = await journal(
      userText("run it"),
      callsTo("callA"),
      resultFor("callA"),
      resultFor("callB"), // the call that issued this never landed
      userText("and then?"),
    );
    expect(shape(log)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "toolResult:callB",
      "user",
    ]);

    const repair = await repairTranscript(log);
    expect(repair?.droppedResults).toEqual([
      expect.objectContaining({ toolCallId: "callB", toolName: "bash" }),
    ]);
    expect(repair?.paddedCalls).toEqual([]);
    expect(shape(log)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "user",
    ]);

    // The repair is in the branch, not in this process: a reload keeps it.
    const reloaded = await SessionLog.load(storage);
    expect(shape(reloaded)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "user",
    ]);
  });

  it("answers a call nothing ever answered, without running anything", async () => {
    const { storage, log } = await journal(
      userText("run it"),
      callsTo("callA"),
      userText("we are back"),
    );

    const repair = await repairTranscript(log);
    expect(repair?.paddedCalls).toEqual([
      expect.objectContaining({ toolCallId: "callA", toolName: "bash" }),
    ]);
    expect(repair?.droppedResults).toEqual([]);
    // The placeholder sits between the call and the next thing said, so the
    // call has an answer in the scope it belongs to.
    expect(shape(log)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "user",
    ]);
    const placeholder = log.transcript()[2];
    expect(placeholder?.role).toBe("toolResult");
    expect(placeholder?.role === "toolResult" && placeholder.isError).toBe(
      true,
    );

    const reloaded = await SessionLog.load(storage);
    expect(shape(reloaded)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "user",
    ]);
  });

  it("repairs both halves of a killed tool batch in one pass", async () => {
    const { log } = await journal(
      userText("run them"),
      callsTo("callA", "callB"),
      resultFor("callA"),
      resultFor("callX"), // no call for this one
      userText("go on"),
    );

    const repair = await repairTranscript(log);
    expect(repair?.droppedResults.map((row) => row.toolCallId)).toEqual([
      "callX",
    ]);
    expect(repair?.paddedCalls.map((row) => row.toolCallId)).toEqual(["callB"]);
    expect(shape(log)).toEqual([
      "user",
      "assistant",
      "toolResult:callA",
      "toolResult:callB",
      "user",
    ]);
  });

  it("leaves a paired transcript exactly as it was", async () => {
    const { storage, log } = await journal(
      userText("run it"),
      callsTo("callA", "callB"),
      resultFor("callA"),
      resultFor("callB"),
      userText("thanks"),
    );
    const before = log.graph.pathOldestFirst().map((entry) => entry.id);

    expect(await repairTranscript(log)).toBeUndefined();
    expect(log.graph.pathOldestFirst().map((entry) => entry.id)).toEqual(
      before,
    );
    expect(shape(await SessionLog.load(storage)).join(",")).toBe(
      "user,assistant,toolResult:callA,toolResult:callB,user",
    );
  });

  it("does not touch history a compaction already cut away", async () => {
    const storage = new MemoryStorage();
    const log = SessionLog.create(storage);
    log.recordMessage(userText("run it"));
    log.recordMessage(callsTo("callA")); // never answered, but cut away below
    log.record({
      id: "compaction-1",
      parentId: null,
      type: "compaction",
      summary: "the earlier work",
      retainedTail: [],
      tokensBefore: 1000,
    });
    log.recordMessage(userText("start again"));
    await log.commit();

    expect(await repairTranscript(log)).toBeUndefined();
    expect(shape(log)).toEqual(["compactionSummary", "user"]);
  });

  it("takes an image the model cannot accept out of the history", async () => {
    // The picture that wedged a session: 1280×11024, refused by every request
    // that carried it. It has to leave the branch for real — a filter at
    // request time would leave the journal unreadable by any other caller.
    const storage = new MemoryStorage();
    const log = SessionLog.create(storage);
    log.recordMessage(callsTo("callA"));
    log.recordMessage({
      role: "toolResult" as const,
      toolCallId: "callA",
      toolName: "read",
      content: [
        { type: "text" as const, text: "Read image file [image/png]" },
        { type: "image" as const, data: tallPng(), mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 0,
    });
    await log.commit();

    const repair = await repairTranscript(log);
    expect(repair?.degradedImages).toHaveLength(1);
    expect(repair?.degradedImages[0]?.detail).toContain("11024");

    const reopened = await SessionLog.load(storage);
    const messages = reopened.transcript();
    // The pair still pairs; the text the tool wrote is still there; no image is.
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(messages)).not.toContain('"image"');
    expect(JSON.stringify(messages)).toContain("Read image file [image/png]");
    expect(JSON.stringify(messages)).toContain("removed from the history");

    // And it heals once: a second open finds nothing to do.
    expect(await repairTranscript(reopened)).toBeUndefined();
  });
});
