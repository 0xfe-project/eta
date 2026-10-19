/**
 * Interrupting a generation (issue #292).
 *
 * The primitive: a stream guard answers a frame with an interrupt, the attempt
 * stops, its partial output is thrown away, the interrupt's messages join the
 * transcript, and the same turn generates again. A scripted model answers one
 * message per request — including the one that gets interrupted, so a script of
 * [bad, good] means "the first attempt streams until stopped, the second is
 * clean".
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../src/index";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, kernelOn, Runner } from "../src/index";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const say = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }] });

const reminder = (text: string): AgentMessage => userMsg(text);

/** The text of every part of a message, joined. */
function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return ((content ?? []) as { text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
}

interface Harness {
  kernel: Kernel;
  runner: Runner;
  fake: ReturnType<typeof fakeModels>;
  ended: AgentMessage[];
  names: string[];
  interrupted: { reason: string; discardedChars: number; count: number }[];
}

function setup(
  script: AssistantMessage[],
  guard: ConstructorParameters<typeof Runner>[1]["guardGeneration"],
  options: { chunkSize?: number; maxInterrupts?: number } = {},
): Harness {
  const kernel = Kernel.create({
    config: { model: { provider: "p", modelId: "m" } },
  });
  const fake = fakeModels(script, { chunkSize: options.chunkSize ?? 3 });
  const runner = new Runner(kernel, {
    models: fake,
    ...(guard === undefined ? {} : { guardGeneration: guard }),
    ...(options.maxInterrupts === undefined
      ? {}
      : { maxInterrupts: options.maxInterrupts }),
  });
  const ended: AgentMessage[] = [];
  const names: string[] = [];
  const interrupted: Harness["interrupted"] = [];
  const on = kernelOn(kernel.ctx);
  on("message:end", (event) => {
    ended.push(event.message);
    names.push("end");
  });
  on("message:start", () => names.push("start"));
  on("generation:interrupted", (event) => {
    names.push("interrupted");
    interrupted.push(event);
  });
  return { kernel, runner, fake, ended, names, interrupted };
}

type Guard = NonNullable<
  ConstructorParameters<typeof Runner>[1]["guardGeneration"]
>;

/**
 * A guard that accumulates the deltas of one generation (the fake's partial holds the
 * finished content from the first frame, a real provider's grows) and interrupts once
 * `needle` appears in what was streamed so far. State resets when it interrupts (a new attempt starts clean).
 */
function onText(needle: string, inject = "do not say that"): Guard {
  let streamed = "";
  return ({ event }) => {
    if (event.type === "text_delta") streamed += event.delta;
    if (!streamed.includes(needle)) return undefined;
    streamed = "";
    return {
      reason: `said ${needle}`,
      source: "test",
      inject: [reminder(inject)],
    };
  };
}

describe("interrupting a generation", () => {
  it("stops on a match that spans frames, discards the partial and generates again", async () => {
    // chunkSize 3 cuts "forbidden" into "for", "bid", "den": no single frame holds it.
    const h = setup(
      [say("this is forbidden territory"), say("a clean answer")],
      onText("forbidden"),
    );
    h.kernel.inject(userMsg("go"));
    const result = await h.runner.run();

    expect(result).toMatchObject({ status: "completed", turns: 1 });
    expect(h.interrupted).toHaveLength(1);
    expect(h.interrupted[0]).toMatchObject({
      count: 1,
      reason: "said forbidden",
    });
    expect(h.interrupted[0]!.discardedChars).toBeGreaterThan(0);
    expect(h.interrupted[0]!.discardedChars).toBeLessThan(
      "this is forbidden territory".length + 1,
    );

    // History: the user turn, the reminder, the clean answer — never the partial.
    const transcript = h.runner.getTranscript().map(textOf);
    expect(transcript).toEqual(["go", "do not say that", "a clean answer"]);
    expect(h.ended.map(textOf).join("|")).not.toContain("forbidden");
  });

  it("announces the interruption between the two generations and keeps one turn", async () => {
    const h = setup([say("xx forbidden"), say("fine")], onText("forbidden"));
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    // user end; first generation start; interrupted; reminder end; second start; its end.
    expect(h.names).toEqual([
      "end",
      "start",
      "interrupted",
      "end",
      "start",
      "end",
    ]);
    expect(h.kernel.turns).toBe(1);
  });

  it("the regenerated request carries the reminder after the user message, not the partial", async () => {
    const h = setup(
      [say("forbidden words"), say("ok")],
      onText("forbidden", "reminder-text"),
    );
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.fake.calls).toHaveLength(2);
    const second = h.fake.calls[1]!.context.messages.map(textOf);
    expect(second).toEqual(["go", "reminder-text"]);
    const first = h.fake.calls[0]!.context.messages.map(textOf);
    expect(first).toEqual(["go"]);
  });

  it("aborts the request behind the stream (the attempt's signal fires, the run's does not)", async () => {
    const h = setup([say("forbidden"), say("ok")], onText("forbidden"));
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    const [first, second] = h.fake.calls.map((call) => call.options?.signal);
    expect(first?.aborted).toBe(true);
    expect(second?.aborted).toBe(false);
  });

  it("interrupts a thinking block and a tool call as readily as text", async () => {
    const thinking = assistantMessage({
      content: [{ type: "thinking", thinking: "I will use forbidden means" }],
    });
    const call = assistantMessage({
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "rm -rf /" },
        },
      ],
      stopReason: "toolUse",
    });
    let thought = "";
    let args = "";
    const h = setup([thinking, call, say("done")], ({ event }) => {
      if (event.type === "thinking_delta") thought += event.delta;
      if (event.type === "toolcall_delta") args += event.delta;
      if (thought.includes("forbidden")) {
        thought = "";
        return { reason: "thinking", inject: [reminder("r1")] };
      }
      if (args.includes("rm")) {
        args = "";
        return { reason: "tool", inject: [reminder("r2")] };
      }
      return undefined;
    });
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.interrupted.map((event) => event.reason)).toEqual([
      "thinking",
      "tool",
    ]);
    expect(h.interrupted.map((event) => event.count)).toEqual([1, 2]);
    expect(h.runner.getTranscript().map(textOf)).toEqual([
      "go",
      "r1",
      "r2",
      "done",
    ]);
  });

  it("does not interrupt a generation the guard lets through", async () => {
    const h = setup([say("all fine here")], onText("forbidden"));
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.interrupted).toEqual([]);
    expect(h.fake.calls).toHaveLength(1);
  });

  it("stops asking after the interrupt budget, and the last generation lands", async () => {
    const h = setup(
      [say("forbidden 1"), say("forbidden 2"), say("forbidden 3")],
      onText("forbidden"),
      { maxInterrupts: 2 },
    );
    h.kernel.inject(userMsg("go"));
    const result = await h.runner.run();
    expect(result.status).toBe("completed");
    expect(h.interrupted).toHaveLength(2);
    expect(h.runner.getTranscript().map(textOf).at(-1)).toBe("forbidden 3");
  });

  it("an interrupt with nothing to inject just regenerates", async () => {
    const h = setup([say("bad"), say("good")], ({ event }) =>
      event.type === "text_delta" && event.delta.includes("bad")
        ? { reason: "retry" }
        : undefined,
    );
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.interrupted[0]).toMatchObject({ reason: "retry" });
    expect(h.runner.getTranscript().map(textOf)).toEqual(["go", "good"]);
  });

  it("the guard sees how many times this turn was interrupted", async () => {
    const seen: number[] = [];
    const h = setup(
      [say("bad"), say("bad again"), say("good")],
      ({ event, interrupts }) => {
        seen.push(interrupts);
        return event.type === "text_delta" && event.delta.includes("bad")
          ? { reason: "again" }
          : undefined;
      },
      { chunkSize: 100 },
    );
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(Math.max(...seen)).toBe(2);
    expect(seen[0]).toBe(0);
  });

  it("guards added later are asked in order, the first interrupt wins, and a guard can be removed", async () => {
    const h = setup([say("bad"), say("good")], undefined, { chunkSize: 100 });
    const asked: string[] = [];
    h.runner.addGenerationGuard(() => {
      asked.push("first");
      return undefined;
    });
    const off = h.runner.addGenerationGuard(({ event }) => {
      asked.push("second");
      return event.type === "text_delta" && event.delta === "bad"
        ? { reason: "second", inject: [reminder("from second")] }
        : undefined;
    });
    h.runner.addGenerationGuard(() => {
      asked.push("third");
      return undefined;
    });
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.interrupted.map((event) => event.reason)).toEqual(["second"]);
    // Interrupting at the second guard means the third never saw that frame.
    expect(asked.slice(0, 2)).toEqual(["first", "second"]);

    off();
    const h2 = setup([say("bad")], undefined, { chunkSize: 100 });
    const off2 = h2.runner.addGenerationGuard(() => ({ reason: "never" }));
    off2();
    h2.kernel.inject(userMsg("go"));
    await h2.runner.run();
    expect(h2.interrupted).toEqual([]);
  });

  it("the discarded usage and size are reported on the event", async () => {
    const h = setup(
      [say("forbidden words here"), say("ok")],
      onText("forbidden"),
    );
    h.kernel.inject(userMsg("go"));
    await h.runner.run();
    expect(h.interrupted[0]).toMatchObject({ count: 1 });
    expect(h.interrupted[0]!.discardedChars).toBe(
      "forbidden words here".length,
    );
  });
});
