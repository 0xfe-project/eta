/**
 * A run delegated to someone else (`kernel/delegate.ts`).
 *
 * The runner keeps the run's lifecycle, its inbox and its abort; the turns are the delegate's.
 * What these pin: a delegated run looks like any run from the bus, steering reaches a run in
 * flight, an abort is an abort, and a delegate that throws is a failed run rather than a crash.
 */
import type {
  AgentMessage,
  RunDelegate,
  RunDelegateContext,
} from "../src/index";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, kernelOn, Runner } from "../src/index";

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) => ("text" in block ? block.text : ""))
        .join("")
    : "";

function setup(delegate: RunDelegate) {
  const kernel = Kernel.create();
  const runner = new Runner(kernel, { models: fakeModels([]), delegate });
  const seen: string[] = [];
  const on = kernelOn(kernel.ctx);
  on("turn:run-start", () => seen.push("run-start"));
  on("message:end", ({ message }) =>
    seen.push(`${message.role}:${textOf(message)}`),
  );
  on("turn:run-failed", ({ error }) => seen.push(`failed:${error}`));
  on("turn:run-end", ({ status }) => seen.push(`run-end:${status}`));
  return { kernel, runner, seen, dispose: () => void kernel.dispose() };
}

const reply = (text: string) =>
  assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

describe("a delegated run", () => {
  it("takes the opening from the inbox, and its messages land like the loop's", async () => {
    let opening: readonly AgentMessage[] = [];
    const { kernel, runner, seen, dispose } = setup({
      run: async (context) => {
        opening = context.opening;
        context.noteTurn();
        context.push(reply("hello back"));
        return { status: "completed" };
      },
    });
    kernel.nextRun("hello");
    const result = await runner.run();
    expect(result).toEqual({ turns: 1, status: "completed" });
    expect(opening.map(textOf)).toEqual(["hello"]);
    expect(seen).toEqual([
      "run-start",
      "user:hello",
      "assistant:hello back",
      "run-end:completed",
    ]);
    expect(runner.getTranscript().map(textOf)).toEqual(["hello", "hello back"]);
    expect(runner.running).toBe(false);
    dispose();
  });

  it("hears a steer queued while it runs, and takes it", async () => {
    let release: () => void = () => undefined;
    const steered: string[] = [];
    const { kernel, runner, seen, dispose } = setup({
      run: async (context: RunDelegateContext) => {
        await new Promise<void>((resolve) => {
          release = context.onInput(() => {
            steered.push(...context.take({ followUps: false }).map(textOf));
            resolve();
          });
        });
        release();
        context.push(reply("done"));
        return { status: "completed" };
      },
    });
    kernel.nextRun("go");
    const run = runner.run();
    await Promise.resolve();
    expect(runner.running).toBe(true);
    kernel.steer("also this");
    await run;
    expect(steered).toEqual(["also this"]);
    expect(kernel.inboxDepth).toBe(0);
    expect(seen).toContain("user:also this");
    dispose();
  });

  it("is told to stop by the abort, and ends aborted", async () => {
    const { kernel, runner, seen, dispose } = setup({
      run: async (context) =>
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", () =>
            resolve({ status: "aborted" }),
          );
        }),
    });
    kernel.nextRun("go");
    const run = runner.run();
    await Promise.resolve();
    runner.abort();
    expect((await run).status).toBe("aborted");
    expect(seen.at(-1)).toBe("run-end:aborted");
    dispose();
  });

  it("fails the run when the delegate fails or throws", async () => {
    const failing = setup({
      run: async () => ({ status: "failed", error: "runtime exited" }),
    });
    failing.kernel.nextRun("go");
    expect(await failing.runner.run()).toMatchObject({
      status: "failed",
      error: "runtime exited",
    });
    expect(failing.seen).toContain("failed:runtime exited");
    failing.dispose();

    const throwing = setup({
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    throwing.kernel.nextRun("go");
    expect(await throwing.runner.run()).toMatchObject({
      status: "failed",
      error: "spawn ENOENT",
    });
    throwing.dispose();
  });

  it("runs the session's tools through the middleware chain", async () => {
    const { kernel, runner, dispose } = setup({
      run: async (context) => {
        const result = await context.executeTool(
          "echo",
          { text: "hi" },
          { toolCallId: "c1" },
        );
        context.push(reply(String(result)));
        return { status: "completed" };
      },
    });
    kernel.tools.register({
      name: "echo",
      execute: (args) => (args as { text: string }).text,
    });
    kernel.tools.use({
      name: "shout",
      after: (_name, _args, result) => String(result).toUpperCase(),
    });
    kernel.nextRun("go");
    await runner.run();
    expect(textOf(runner.getTranscript().at(-1)!)).toBe("HI");
    dispose();
  });
});
