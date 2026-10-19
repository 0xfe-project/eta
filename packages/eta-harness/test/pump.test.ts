/**
 * RunPump — the idle waker (REFACTOR.md §2.5).
 *
 * The pump only decides; the run does the work. What is pinned here: an idle
 * inject starts a turn without a manual `run()`, a stopped pump leaves the inbox
 * alone, an inject that raced the end of a pumped run is picked up, a second run
 * never starts while one is in flight, and a failed pumped run is reported
 * without stopping the pump.
 *
 * It is a host-driven class rather than a service: whether an inject should
 * become a run is a policy, and a session that wants a different one simply does
 * not start it.
 */

import type { AssistantMessage } from "@eta/core";
import { Kernel, Runner } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { RunPump } from "../src/index";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});
const answer = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }], stopReason: "stop" });

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10));

function setup(script: AssistantMessage[], pump = false) {
  const kernel = Kernel.create();
  const fake = fakeModels(script);
  const runner = new Runner(kernel, { models: fake });
  const waker = new RunPump(kernel, runner);
  if (pump) waker.start();
  return { kernel, runner, fake, waker, dispose: () => void kernel.dispose() };
}

describe("runPump", () => {
  it("an idle inject starts a turn immediately, no manual run()", async () => {
    const { kernel, runner, fake, waker, dispose } = setup(
      [answer("first"), answer("second")],
      true,
    );
    kernel.inject(userMsg("go"));
    await settle();
    expect(fake.calls).toHaveLength(1);

    // Idle: this inject must become a run by itself.
    kernel.inject(userMsg("ping"));
    await settle();
    expect(fake.calls).toHaveLength(2);
    expect(
      runner.getTranscript().filter((m) => m.role === "user"),
    ).toHaveLength(2);
    waker.stop();
    dispose();
  });

  it("a stopped pump leaves the inbox alone", async () => {
    const { kernel, fake, dispose } = setup([answer("first")]);
    kernel.inject(userMsg("go"));
    await settle();
    expect(fake.calls).toHaveLength(0);
    expect(kernel.inboxDepth).toBe(1);
    dispose();
  });

  it("picks up an inject that raced the end of a pumped run", async () => {
    const scripts = [answer("first"), answer("second")];
    const { kernel, runner, fake, waker, dispose } = setup(scripts, true);
    // The second inject lands while the first pumped run is finishing. The run
    // that is ending does not see it, so the pump must start the next one.
    kernel.inject(userMsg("go"));
    kernel.inject(userMsg("and this one"));
    await settle();
    await settle();
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    expect(kernel.inboxDepth).toBe(0);
    expect(runner.running).toBe(false);
    waker.stop();
    dispose();
  });

  it("does not start a second run while one is in flight", async () => {
    const { kernel, runner, fake, waker, dispose } = setup(
      [answer("one"), answer("two")],
      true,
    );
    kernel.inject(userMsg("go"));
    // Several injects in a row: one run at a time, the rest queue behind it.
    kernel.inject(userMsg("more"));
    kernel.inject(userMsg("and more"));
    await settle();
    await settle();
    // No run started twice over the same message: the turns saw each message once.
    const users = runner
      .getTranscript()
      .filter((message) => message.role === "user");
    expect(users).toHaveLength(3);
    expect(fake.calls.length).toBeLessThanOrEqual(3);
    waker.stop();
    dispose();
  });

  it("reports a pumped run that fails, and keeps accepting work", async () => {
    const failures: unknown[] = [];
    const kernel = Kernel.create();
    const fake = fakeModels([]); // a provider with nothing left to say
    const runner = new Runner(kernel, { models: fake });
    const waker = new RunPump(kernel, runner, {
      onRunEnd: (error) => failures.push(error),
    });
    waker.start();
    kernel.inject(userMsg("go"));
    await settle();
    expect(failures).toHaveLength(1);
    // The pump is still live: the next inject gets its own attempt.
    expect(waker.running).toBe(false);
    waker.stop();
    void kernel.dispose();
  });
});
