/**
 * Overflow recovery (REFACTOR.md §2.4, ported from eta-agent's
 * drive/response.ts).
 *
 * A request that does not fit the model's window cannot be fixed by sending it
 * again: the history has to shrink first. So an overflow — an error the
 * provider classified as a context/limit failure, or a length stop that used
 * less than the requested output — triggers one compaction and one retry, with
 * no backoff. A second overflow, or a driver that cannot compact, is a real
 * failure.
 *
 * The driver here is a fake: how a summary is produced (arithmetic, prompt,
 * model call) is the harness's and the plugin's business. What this file pins is
 * the kernel's side — when it asks, and what it does with the answer.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  type FakeCompaction,
  fakeCompaction,
  fakeModels,
} from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { Kernel, Runner } from "../src/index";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

/** What a provider says when the prompt does not fit. */
const overflowError = (
  message = "prompt is too long: 210000 tokens > 200000 maximum",
): AssistantMessage =>
  assistantMessage({ stopReason: "error", errorMessage: message });

/** A length stop that used less output than asked for: the window truncated it. */
const lengthStop = (outputTokens: number): AssistantMessage =>
  assistantMessage({
    stopReason: "length",
    content: [{ type: "text", text: "half an ans" }],
    usage: {
      input: 199_000,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 199_000 + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

const ok = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

function setup(
  script: AssistantMessage[],
  options: { compacts?: { overflow?: boolean } } = {},
) {
  const driver: FakeCompaction = fakeCompaction({
    summary: "compacted history",
    ...(options.compacts === undefined ? {} : { compacts: options.compacts }),
  });
  const kernel = Kernel.create({
    config: { model: { provider: "p", modelId: "m" } },
  });
  const fake = fakeModels(script);
  // A model with a window and an output budget, so both overflow signals work.
  fake.getModel = () =>
    ({
      provider: "fake",
      id: "fake-model",
      api: "openai-completions",
      contextWindow: 200_000,
      maxTokens: 8_192,
    }) as never;
  const runner = new Runner(kernel, {
    models: fake,
    compaction: driver,
    toProviderMessages: (messages) =>
      messages.flatMap((message) =>
        message.role === "compactionSummary"
          ? [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: `<summary>${message.summary}</summary>`,
                  },
                ],
                timestamp: 0,
              },
            ]
          : [message as never],
      ),
  });
  return {
    kernel,
    runner,
    fake,
    driver,
    dispose: () => void kernel.dispose(),
  };
}

describe("context overflow", () => {
  it("compacts once and retries the request without a backoff", async () => {
    const { kernel, runner, fake, driver, dispose } = setup([
      overflowError(),
      ok("fits now"),
    ]);
    kernel.inject(userMsg("go"));
    const result = await runner.run();

    expect(result.error).toBeUndefined();
    expect(driver.compactions).toEqual(["overflow"]);
    expect(fake.calls).toHaveLength(2);
    // The retried request carries the summary, not the history that overflowed.
    expect(JSON.stringify(fake.calls.at(-1)!.context.messages)).toContain(
      "compacted history",
    );
    dispose();
  });

  it("recovers a length stop that the window truncated", async () => {
    const { kernel, runner, fake, driver, dispose } = setup([
      lengthStop(120),
      ok("finished"),
    ]);
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.error).toBeUndefined();
    expect(driver.compactions).toEqual(["overflow"]);
    expect(fake.calls).toHaveLength(2);
    dispose();
  });

  it("gives up after one recovery: a second overflow is a failure", async () => {
    const { kernel, runner, fake, driver, dispose } = setup([
      overflowError(),
      overflowError("still too long"),
    ]);
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.error).toContain("still too long");
    expect(driver.compactions).toHaveLength(1); // the single recovery attempt
    expect(fake.calls).toHaveLength(2);
    dispose();
  });

  it("fails when nothing can compact the history", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([overflowError()]);
    fake.getModel = () =>
      ({
        provider: "fake",
        id: "fake-model",
        api: "openai-completions",
        contextWindow: 200_000,
      }) as never;
    const runner = new Runner(kernel, { models: fake });
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.error).toContain("prompt is too long");
    expect(fake.calls).toHaveLength(1);
    void kernel.dispose();
  });

  it("fails when the driver declines to compact", async () => {
    const { kernel, runner, fake, driver, dispose } = setup([overflowError()], {
      compacts: { overflow: false },
    });
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.error).toContain("prompt is too long");
    expect(driver.signals).toEqual(["threshold", "overflow"]);
    expect(driver.compactions).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    dispose();
  });

  it("an overflow recovery and a transport retry do not consume each other's budget", async () => {
    // First a transport failure (retried by policy), then an overflow (recovered
    // by compaction), then success.
    const transient = assistantMessage({
      stopReason: "error",
      errorMessage: "upstream 503",
    });
    const { kernel, runner, fake, driver, dispose } = setup([
      transient,
      overflowError(),
      ok("finally"),
    ]);
    kernel.inject(userMsg("go"));
    // The retry backoff is real, so let the timer pass.
    const run = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const result = await run;
    expect(result.error).toBeUndefined();
    expect(fake.calls).toHaveLength(3);
    expect(driver.compactions).toEqual(["overflow"]);
    dispose();
  });
});
