/**
 * Crash recovery against a real file (REFACTOR.md §K5 acceptance).
 *
 * A process is a storage handle, a crash is abandoning that handle, and the
 * disk is the path. The half-written line is put there by hand, the way a
 * killed process leaves it. The rule under test: committed turns survive
 * intact; only the torn tail is dropped.
 */

import type { AssistantMessage } from "@eta/core";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { journaledKernel } from "@eta/harness/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonlStorage } from "../src/index";

let dir = "";
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-recovery-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function nextPath(): string {
  counter += 1;
  return join(dir, `session-${counter}.jsonl`);
}

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const answer = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

/** A process: open the journal, run one turn, hand back the pieces. */
async function processRun(
  path: string,
  script: AssistantMessage[],
  prompt: string,
) {
  const storage = await JsonlStorage.open(path);
  const log = SessionLog.create(storage);
  const { kernel, journaling } = journaledKernel(log);
  const fake = fakeModels(script);
  const runner = new Runner(kernel, { models: fake, journal: journaling });
  kernel.inject(userMsg(prompt));
  const result = await runner.run();
  kernel.dispose();
  return { storage, log, result, fake };
}

describe("crash recovery on disk", () => {
  it("a clean session's journal replays into the same state", async () => {
    const path = nextPath();
    const first = await processRun(
      path,
      [answer("the answer")],
      "first question",
    );
    await first.storage.commit([
      {
        kind: "value",
        op: "set",
        namespace: "session.model",
        key: "",
        value: "pro6000/k3",
      },
    ]);
    await first.storage.close();

    const after = await JsonlStorage.open(path);
    const log = await SessionLog.load(after);
    expect(log.transcript()).toHaveLength(2);
    expect(
      (
        await after.getValue({
          kind: "value",
          namespace: "session.model",
          key: "",
        })
      )?.value,
    ).toBe("pro6000/k3");
    await after.close();
  });

  it("a kill mid-run keeps the committed turns and drops only the torn tail", async () => {
    const path = nextPath();
    const settled = await processRun(
      path,
      [answer("settled answer")],
      "settled question",
    );
    await settled.storage.close();

    // A second process gets one turn committed, then is killed mid-append.
    const dying = await JsonlStorage.open(path);
    const log = SessionLog.create(dying);
    log.recordMessage(userMsg("question the run was answering") as never);
    await log.commit();
    await dying.close();
    // What the killed process left behind: a torn append.
    await appendFile(
      path,
      `{"w":[{"kind":"entry","entry":{"id":"half"`,
      "utf8",
    );

    const reopened = await JsonlStorage.open(path);
    const repaired = await reopened.repairTornTail();
    expect(repaired.trailingOnly).toBe(true);
    expect(repaired.droppedRecords).toBe(1);

    const recovered = await SessionLog.load(reopened);
    // Both committed turns are intact; the torn line never became an entry.
    const texts = recovered.transcript().flatMap((message) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      )
        return [];
      const content = message.content;
      return (Array.isArray(content) ? content : [])
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text);
    });
    expect(texts).toEqual([
      "settled question",
      "settled answer",
      "question the run was answering",
    ]);
    await recovered.storage.close();

    // The journal is clean and reusable afterwards.
    for (const line of (await readFile(path, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
