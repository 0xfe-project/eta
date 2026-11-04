/**
 * Every snippet the realm prompt shows runs here, in a real session, one esmrun per
 * script (#434): the prompt may only promise what the realm does.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { REALM_EXAMPLES, renderPlatformBlock } from "../src/prompts/platform";

const call = (script: string, id: string) =>
  assistantMessage({
    stopReason: "toolUse",
    content: [
      { type: "toolCall" as const, id, name: "esmrun", arguments: { script } },
    ],
  });
const stop = (text = "done") =>
  assistantMessage({ content: [{ type: "text", text }] });

/** Model replies a script consumes from inside the realm (nested turns, llm calls). */
const innerReplies = (script: string) =>
  script.includes("eta.ask(")
    ? 2
    : script.includes("eta.platform.llm(")
      ? 1
      : 0;

async function runExample(scripts: string[]) {
  const root = await mkdtemp(join(tmpdir(), "realm-root-"));
  const cwd = await mkdtemp(join(tmpdir(), "realm-cwd-"));
  const turns = scripts.flatMap((script, i) => [
    call(script, `r${i}`),
    ...Array.from({ length: innerReplies(script) }, () => stop("inner answer")),
  ]);
  const session = await openSession({
    storage: new MemoryStorage(),
    models: fakeModels([...turns, stop()]) as never,
    cwd,
    esm: { root },
  });
  session.kernel.nextRun({
    role: "user",
    content: [{ type: "text", text: "go" }],
    timestamp: 0,
  });
  await session.runner.run();
  const results = scripts.map((_, i) => {
    const found = session.runner
      .getTranscript()
      .find((m) => m.role === "toolResult" && m.toolCallId === `r${i}`) as
      | { isError?: boolean; content: { text?: string }[] }
      | undefined;
    return {
      isError: found?.isError ?? true,
      text: found?.content.map((p) => p.text ?? "").join("") ?? "(no result)",
    };
  });
  session.stop();
  return results;
}

describe("the realm prompt", () => {
  it("shows every example", () => {
    const info = {
      cwd: "/w",
      home: "/h",
      configPath: "/h/.eta/config.json",
      memoryTarget: "/w/.eta/MEMORY.md",
      memoryExists: true,
    };
    expect(renderPlatformBlock(info)).not.toContain("esmrun");
    const text = renderPlatformBlock({ ...info, realm: true });
    expect(text).toContain("same model instance");
    expect(text).toContain("time limit");
    expect(text).toContain("`mention`");
    expect(text).toContain("always give `base`");
    for (const example of REALM_EXAMPLES)
      for (const script of example.scripts) expect(text).toContain(script);
  });

  it.each(REALM_EXAMPLES.map((e) => [e.title, e.scripts] as const))(
    "runs: %s",
    async (_title, scripts) => {
      const results = await runExample([...scripts]);
      for (const result of results) {
        expect(result.text).not.toContain("Error");
        expect(result.isError).toBe(false);
      }
    },
    30_000,
  );

  it("the examples produce what they say", async () => {
    const [shell] = await runExample(REALM_EXAMPLES[1]!.scripts);
    expect(shell!.text).toContain("killed by SIGTERM");
    expect(shell!.text).toContain('"a",');
    expect(shell!.text).toContain('"ok": true');
    const [quoting] = await runExample(REALM_EXAMPLES[0]!.scripts);
    expect(quoting!.text).toContain("my notes; rm -rf ~");
    const [edited] = await runExample(REALM_EXAMPLES[2]!.scripts);
    expect(edited!.text).toContain("1: const port = Number(config.port);");
    const state = await runExample(REALM_EXAMPLES[3]!.scripts);
    expect(state[1]!.text).toContain("hello-world");
  }, 60_000);
});
