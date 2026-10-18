/**
 * Memory, wired into a session (H11c).
 *
 * The pieces were all here — `MemoryCache`, `envMemoryFs`, `extractMemoryAtRunEnd`
 * — and a session used none of them: nothing read `MEMORY.md` into a prompt, and
 * nothing asked at the end of a run what was worth keeping. What is pinned here is
 * the wiring, and the properties that make it safe to have a model write files by
 * itself: a note reaches the next prompt, a file changed outside the session is
 * picked up, and no extraction failure ever costs a turn.
 */

import type { KernelModels } from "@eta/core";
import type { ExecutionEnv } from "@eta/execution";
import type { MemoryExtractionOutcome } from "../src/memory";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { MemoryEnvironment } from "../src/env/memory";
import { envMemoryFs } from "../src/memory";
import { openSession } from "../src/open";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const answer = (text: string) =>
  assistantMessage({ content: [{ type: "text", text }] });

/** A session whose environment stands in for a project directory. */
async function projectMemory() {
  const env = new MemoryEnvironment({ cwd: "/work/eta" });
  await env.writeFile("/work/eta/.git/HEAD", "ref: refs/heads/main");
  return { env, fs: envMemoryFs(env as unknown as ExecutionEnv) };
}

const promptOf = (models: {
  calls: { context: { systemPrompt?: string | undefined } }[];
}): string => models.calls.at(-1)?.context.systemPrompt ?? "";

describe("the memory block in a session", () => {
  it("reads MEMORY.md into the prompt, and re-reads it when the file changes", async () => {
    const { env, fs } = await projectMemory();
    await env.writeFile(
      "/work/eta/.eta/MEMORY.md",
      "# eta memory (untrusted)\n\n## decision\n\n- [1] the harness owns prompts\n",
    );
    const models = fakeModels([answer("first"), answer("second")]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      memory: { fs, cwd: "/work/eta", home: "/home/u" },
    });

    session.kernel.inject(userMsg("one"));
    await session.runner.run();
    expect(promptOf(models)).toContain("the harness owns prompts");
    // The block is the adaptive tail: it comes after the stable sections.
    expect(
      promptOf(models).indexOf("the harness owns prompts"),
    ).toBeGreaterThan(promptOf(models).indexOf("You are Eta"));
    expect(session.memory).toBeDefined();

    // Someone edits the file between turns (a human, or another session): the next
    // prompt has the new note, and not the old one.
    await env.writeFile(
      "/work/eta/.eta/MEMORY.md",
      "# eta memory (untrusted)\n\n## decision\n\n- [1] the harness owns prompts\n\n## lesson\n\n- [2] POMELO-3 means the cache is cold\n",
    );
    session.kernel.inject(userMsg("two"));
    await session.runner.run();
    expect(promptOf(models)).toContain("POMELO-3");

    await session.kernel.dispose();
    session.stop();
  });

  it("has no memory block when the project has none", async () => {
    const { fs } = await projectMemory();
    const models = fakeModels([answer("ok")]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      memory: { fs, cwd: "/work/eta", home: "/home/u" },
    });
    session.kernel.inject(userMsg("hello"));
    await session.runner.run();
    const prompt = promptOf(models);
    expect(prompt).toContain("You are Eta");
    // (The base prompt mentions `<memory>` — it tells the agent what a memory block
    // is — so the check is for the rendered note file, not for the tag.)
    expect(prompt).not.toContain("eta memory (untrusted)");

    // The target is still resolved, so the platform briefing can name where a note
    // would go — memory that does not exist yet is not the same as no memory.
    expect((await session.memory!.load("/work/eta")).target.path).toBe(
      "/work/eta/.eta/MEMORY.md",
    );

    await session.kernel.dispose();
    session.stop();
  });
});

describe("the run-end extraction", () => {
  it("asks what was worth keeping, and writes it where the block reads", async () => {
    const { env, fs } = await projectMemory();
    const outcomes: MemoryExtractionOutcome[] = [];
    const models = fakeModels([
      answer(`I looked at the runner and the harness: ${"x".repeat(300)}`),
      // The extraction call is a one-shot request on the same model layer; this is
      // its answer (the harness parses the json block out of it).
      answer(
        '{"add_new_decision":["the harness owns the prompt assembly"],"add_new_preference":[],"learn_new_lesson":["POMELO-9 marks a cold cache"],"remove_memory_ids":[]}',
      ),
    ]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      memory: {
        fs,
        cwd: "/work/eta",
        home: "/home/u",
        call: async (systemPrompt, prompt) => {
          // The composition root owns auth and model choice: this is the seam.
          expect(systemPrompt.length).toBeGreaterThan(0);
          expect(prompt).toContain("looked at the runner");
          const result = await (models as KernelModels).completeSimple(
            models.getModel("fake", "fake-model")!,
            {
              systemPrompt,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: prompt }],
                  timestamp: 0,
                },
              ],
            },
            {},
          );
          return (result.content[0] as { text: string }).text;
        },
        onExtraction: (outcome) => outcomes.push(outcome),
      },
    });
    session.kernel.inject(userMsg("go"));
    await session.runner.run();
    // The boundary does not wait for the extraction: give the fire-and-forget call
    // a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const written = await env.readTextFile("/work/eta/.eta/MEMORY.md");
    expect(written.ok && written.value).toContain(
      "the harness owns the prompt assembly",
    );
    expect(written.ok && written.value).toContain(
      "POMELO-9 marks a cold cache",
    );
    expect(outcomes.at(-1)).toMatchObject({ added: 2, removed: 0 });
    // And the note is in the prompt of the next turn, from the file, not from
    // anything the session kept in memory.
    expect((await session.memory!.load("/work/eta")).text).toContain(
      "POMELO-9",
    );

    await session.kernel.dispose();
    session.stop();
  });

  it("skips a thin conversation instead of spending a call on it", async () => {
    const { env, fs } = await projectMemory();
    let calls = 0;
    const outcomes: MemoryExtractionOutcome[] = [];
    const models = fakeModels([answer("ok")]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      memory: {
        fs,
        cwd: "/work/eta",
        home: "/home/u",
        call: async () => {
          calls += 1;
          return "{}";
        },
        onExtraction: (outcome) => outcomes.push(outcome),
      },
    });
    session.kernel.inject(userMsg("hi"));
    await session.runner.run();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toBe(0);
    expect(outcomes.at(-1)?.skipped).toBe("thin");
    const exists = await env.exists("/work/eta/.eta/MEMORY.md");
    expect(exists.ok && exists.value).toBe(false);

    await session.kernel.dispose();
    session.stop();
  });

  it("does not fail the run when the extraction blows up", async () => {
    const { fs } = await projectMemory();
    const outcomes: MemoryExtractionOutcome[] = [];
    const models = fakeModels([answer(`the run finished ${"y".repeat(300)}`)]);
    const session = await openSession({
      storage: new MemoryStorage(),
      models: models as never,
      memory: {
        fs,
        cwd: "/work/eta",
        home: "/home/u",
        call: async () => {
          throw new Error("the extraction model is down");
        },
        onExtraction: (outcome) => outcomes.push(outcome),
      },
    });
    session.kernel.inject(userMsg("go"));
    const result = await session.runner.run();
    expect(result.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The failure is reported, not swallowed, and the run is still a completed run.
    expect(outcomes.at(-1)?.skipped).toBe("provider");
    expect(outcomes.at(-1)?.reason).toContain("extraction model is down");

    await session.kernel.dispose();
    session.stop();
  });

  it("reads the transcript from the journal, so a restart continues the notes", async () => {
    const { fs } = await projectMemory();
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([
        answer(`the first answer ${"z".repeat(300)}`),
      ]) as never,
    });
    // A real run: the question reaches the journal when the run adopts it, and the
    // extraction reads the journal.
    first.kernel.inject(userMsg("a question worth remembering"));
    await first.runner.run();
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    const seen: string[] = [];
    const models = fakeModels([
      answer(
        '{"add_new_decision":[],"add_new_preference":[],"learn_new_lesson":[],"remove_memory_ids":[]}',
      ),
    ]);
    const restarted = await openSession({
      storage,
      models: models as never,
      memory: {
        fs,
        cwd: "/work/eta",
        home: "/home/u",
        call: async (_system, prompt) => {
          seen.push(prompt);
          return '{"add_new_decision":[],"add_new_preference":[],"learn_new_lesson":[],"remove_memory_ids":[]}';
        },
      },
    });
    restarted.kernel.inject(userMsg("carry on"));
    await restarted.runner.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both turns are in what the extraction read: the replayed one and the new one.
    expect(seen.join(" ")).toContain("a question worth remembering");
    expect(seen.join(" ")).toContain("carry on");

    await restarted.kernel.dispose();
    restarted.stop();
  });
});
