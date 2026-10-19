/**
 * Streaming rules, end to end: a scripted model streams in small chunks, the plugin watches the
 * frames through the runner's generation guard, and what the model is sent next is checked.
 *
 * A script entry is one request's answer, including the answer that gets interrupted: a script of
 * [bad, good] means "the first attempt streams until a rule stops it, the second is clean".
 */
import type { AgentMessage } from "@eta/core";
import type { StreamState, TriggerStore } from "../src";
import { Kernel, kernelOn, Runner } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { AkhookSession } from "../src";

type AssistantMessage = ReturnType<typeof assistantMessage>;

const userMsg = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});

const say = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }] });
const think = (thinking: string, text = "done"): AssistantMessage =>
  assistantMessage({
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  });
const call = (
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
): AssistantMessage =>
  assistantMessage({
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
  });
const edit = (path: string, newText: string, id?: string) =>
  call("edit", { path, edits: [{ oldText: "x", newText }] }, id);

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return ((content ?? []) as { text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
}

const rule = (body: string, id = "r") =>
  `  - id: ${id}\n    on: stream\n    message: ${JSON.stringify(`reminder from ${id}`)}\n${body}`;

function memoryStore(): TriggerStore & { saved: StreamState[] } {
  const saved: StreamState[] = [];
  return {
    saved,
    load: async () => saved.at(-1),
    save: (state) => {
      saved.push(structuredClone(state));
    },
  };
}

async function setup(
  rules: string,
  script: AssistantMessage[],
  options: { store?: TriggerStore; chunkSize?: number } = {},
) {
  const kernel = Kernel.create({
    config: { model: { provider: "p", modelId: "m" } },
  });
  const fake = fakeModels(script, { chunkSize: options.chunkSize ?? 3 });
  const runner = new Runner(kernel, { models: fake });
  const executed: { name: string; args: unknown }[] = [];
  for (const name of ["edit", "write", "bash"]) {
    kernel.tools.register({
      name,
      execute: (args: unknown) => {
        executed.push({ name, args });
        return `${name} ok`;
      },
    });
  }
  const akhook = new AkhookSession({
    cwd: "/project",
    ask: undefined,
    userConfigPath: "/nonexistent/akhook.yml",
    additional: () => [{ name: "test", text: `version: 1\nrules:\n${rules}` }],
    ...(options.store === undefined ? {} : { store: options.store }),
  });
  kernel.tools.use(akhook.middleware);
  await akhook.attach({ runner, kernel });
  const interrupted: string[] = [];
  const ended: AgentMessage[] = [];
  kernelOn(kernel.ctx)("generation:interrupted", (event) => {
    interrupted.push(event.source ?? "");
  });
  kernelOn(kernel.ctx)("message:end", (event) => {
    ended.push(event.message);
  });
  const run = async (prompt = "go") => {
    kernel.inject(userMsg(prompt));
    return await runner.run();
  };
  return { kernel, runner, fake, akhook, executed, interrupted, ended, run };
}

/** What a request carried, as text. */
const sent = (
  fake: { calls: { context: { messages: AgentMessage[] } }[] },
  n: number,
) => fake.calls[n]!.context.messages.map(textOf);

describe("interrupting rules", () => {
  const forbidden = rule(
    `    checks: [{regex: 'forbidden'}]\n    interrupt_mode: always\n`,
  );

  it("match across stream chunks, drop the partial, inject the rule, and generate again in the same turn", async () => {
    const s = await setup(forbidden, [
      say("this is forbidden territory"),
      say("a clean answer"),
    ]);
    const result = await s.run();
    expect(result).toMatchObject({ status: "completed", turns: 1 });
    expect(s.interrupted).toEqual(["r"]);
    // The model is asked again with the user turn and the rule, never its own partial.
    expect(s.fake.calls).toHaveLength(2);
    expect(sent(s.fake, 0)).toEqual(["go"]);
    const second = sent(s.fake, 1);
    expect(second[0]).toBe("go");
    expect(second[1]).toContain(
      '<system-interrupt reason="rule_violation" rule="r">',
    );
    expect(second[1]).toContain("reminder from r");
    expect(second).toHaveLength(2);
    expect(s.runner.getTranscript().map(textOf).join("|")).not.toContain(
      "forbidden territory",
    );
    expect(s.runner.getTranscript().at(-1)).toMatchObject({
      role: "assistant",
    });
  });

  it("fire once per session by default: the same text later lands", async () => {
    const s = await setup(forbidden, [say("forbidden one"), say("clean")]);
    await s.run();
    const again = await setup(forbidden, [
      say("forbidden"),
      say("fine"),
      say("forbidden again"),
    ]);
    await again.run();
    await again.run("second");
    expect(again.interrupted).toEqual(["r"]);
    expect(again.runner.getTranscript().map(textOf).at(-1)).toBe(
      "forbidden again",
    );
  });

  it("repeat_mode after-gap lets it fire again after repeat_gap completed turns", async () => {
    const s = await setup(
      rule(
        `    checks: [{regex: 'forbidden'}]\n    repeat_mode: after-gap\n    repeat_gap: 2\n`,
      ),
      [
        say("forbidden"), // interrupted (turn 1 in progress)
        say("fine"), // turn 1 completes
        say("forbidden"), // turn 2: gap is 1 → lands
        say("forbidden"), // turn 3: gap is 2 → interrupted
        say("fine again"),
      ],
    );
    await s.run();
    expect(s.interrupted).toEqual(["r"]);
    await s.run("two");
    expect(s.interrupted).toEqual(["r"]);
    await s.run("three");
    expect(s.interrupted).toEqual(["r", "r"]);
  });

  it("scope: text by default, not thinking; `thinking` opts in", async () => {
    const plain = await setup(forbidden, [think("forbidden thoughts")]);
    await plain.run();
    expect(plain.interrupted).toEqual([]);

    const watching = await setup(
      rule(`    scope: thinking\n    checks: [{regex: 'forbidden'}]\n`),
      [think("forbidden thoughts"), think("calm thoughts")],
    );
    await watching.run();
    expect(watching.interrupted).toEqual(["r"]);
  });

  it("scope tool:<name>(<glob>) watches the content an edit or write introduces", async () => {
    const rs = rule(
      `    scope: ["tool:edit(*.rs)", "tool:write(*.rs)"]\n    checks: [{regex: 'Box::leak'}]\n`,
    );
    // An edit of a .rs file is stopped; the same text in a .ts file, or in plain text, is not.
    const hit = await setup(rs, [
      edit("/project/src/lib.rs", "let x = Box::leak(b);"),
      say("ok"),
    ]);
    await hit.run();
    expect(hit.interrupted).toEqual(["r"]);
    expect(hit.executed).toEqual([]);

    const miss = await setup(rs, [
      edit("/project/src/lib.ts", "Box::leak"),
      say("mentioning Box::leak in prose"),
    ]);
    await miss.run();
    expect(miss.interrupted).toEqual([]);
    expect(miss.executed).toHaveLength(1);
  });

  it("a tool call interrupted before it ends never runs, and its partial arguments are not history", async () => {
    const s = await setup(
      rule(`    scope: tool\n    checks: [{regex: 'rm -rf'}]\n`),
      [call("bash", { command: "rm -rf /" }), say("not doing that")],
    );
    await s.run();
    expect(s.executed).toEqual([]);
    expect(s.interrupted).toEqual(["r"]);
    expect(JSON.stringify(s.runner.getTranscript())).not.toContain("rm -rf /");
  });

  it("paths gate a rule to the files it names", async () => {
    const s = await setup(
      rule(
        `    scope: tool\n    paths: ["**/generated/**"]\n    checks: [{regex: 'TODO'}]\n`,
      ),
      [edit("/project/src/a.ts", "TODO"), say("one")],
    );
    await s.run();
    expect(s.interrupted).toEqual([]);
    const g = await setup(
      rule(
        `    scope: tool\n    paths: ["**/generated/**"]\n    checks: [{regex: 'TODO'}]\n`,
      ),
      [edit("/project/generated/a.ts", "TODO"), say("two")],
    );
    await g.run();
    expect(g.interrupted).toEqual(["r"]);
  });

  it("structural conditions are checked on the finished tool call", async () => {
    const ast = rule(
      `    scope: ["tool:edit(*.ts)"]\n    checks: [{ast: {language: tsx, pattern: 'const $A: any = $B'}}]\n`,
    );
    const s = await setup(ast, [
      edit("/project/a.ts", "const x: any = 1;"),
      say("rewritten"),
    ]);
    await s.run();
    expect(s.interrupted).toEqual(["r"]);
    const clean = await setup(ast, [
      edit("/project/a.ts", "const x: number = 1;"),
      say("ok"),
    ]);
    await clean.run();
    expect(clean.interrupted).toEqual([]);
  });

  it("several matching rules interrupt once and all give their reminder", async () => {
    const s = await setup(
      rule(`    checks: [{regex: 'foo'}]\n`, "a") +
        rule(`    checks: [{regex: 'foo'}]\n`, "b"),
      [say("foo"), say("fine")],
    );
    await s.run();
    expect(s.interrupted).toEqual(["a,b"]);
    expect(sent(s.fake, 1)[1]).toContain("reminder from a");
    expect(sent(s.fake, 1)[1]).toContain("reminder from b");
  });
});

describe("interrupt modes", () => {
  const body = (mode: string, scope = "[text, tool]") =>
    rule(
      `    scope: ${scope}\n    checks: [{regex: 'bad'}]\n    interrupt_mode: ${mode}\n`,
    );

  it("prose-only interrupts text and thinking, but only reminds about a tool call", async () => {
    const text = await setup(body("prose-only"), [say("bad words"), say("ok")]);
    await text.run();
    expect(text.interrupted).toEqual(["r"]);

    const tool = await setup(body("prose-only"), [
      edit("/project/a.ts", "bad", "c1"),
      say("ok"),
    ]);
    await tool.run();
    expect(tool.interrupted).toEqual([]);
    expect(tool.executed).toHaveLength(1);
  });

  it("tool-only interrupts a tool call, but only reminds about text", async () => {
    const tool = await setup(body("tool-only"), [
      edit("/project/a.ts", "bad"),
      say("ok"),
    ]);
    await tool.run();
    expect(tool.interrupted).toEqual(["r"]);
    expect(tool.executed).toEqual([]);

    const text = await setup(body("tool-only"), [say("bad words")]);
    await text.run();
    expect(text.interrupted).toEqual([]);
  });

  it("never lets the call run and puts the reminder beside its own result", async () => {
    const s = await setup(body("never"), [
      edit("/project/a.ts", "bad content", "c1"),
      say("done"),
    ]);
    await s.run();
    expect(s.interrupted).toEqual([]);
    expect(s.executed).toHaveLength(1);
    const results = s.runner
      .getTranscript()
      .filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    const text = textOf(results[0]!);
    expect(text).toContain("edit ok");
    expect(text).toContain(
      '<system-reminder reason="rule_violation" rule="r">',
    );
    expect(text).toContain("reminder from r");
    // The model reads it on its next request.
    expect(sent(s.fake, 1).join("\n")).toContain("reminder from r");
  });

  it("never on prose waits for the next tool result and counts as fired only when delivered", async () => {
    const s = await setup(body("never", "text"), [
      assistantMessage({
        content: [
          { type: "text", text: "bad words first" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        stopReason: "toolUse",
      }),
      say("done"),
    ]);
    await s.run();
    const result = s.runner
      .getTranscript()
      .find((message) => message.role === "toolResult")!;
    expect(textOf(result)).toContain("reminder from r");
    expect(s.akhook.streams.snapshot().injected).toHaveProperty("r");
  });

  it("never on prose with no tool result to ride on is dropped, and may fire later", async () => {
    const s = await setup(body("never", "text"), [
      say("bad words"),
      say("bad again"),
      assistantMessage({
        content: [
          { type: "text", text: "bad third" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        stopReason: "toolUse",
      }),
      say("done"),
    ]);
    await s.run();
    expect(s.akhook.streams.snapshot().injected).toEqual({});
    await s.run("second");
    expect(s.akhook.streams.snapshot().injected).toEqual({});
    await s.run("third");
    expect(s.akhook.streams.snapshot().injected).toHaveProperty("r");
  });

  it("a soft reminder is delivered once, not once per call", async () => {
    const s = await setup(body("never", "tool"), [
      assistantMessage({
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "edit",
            arguments: {
              path: "/p/a.ts",
              edits: [{ oldText: "", newText: "bad" }],
            },
          },
          {
            type: "toolCall",
            id: "c2",
            name: "edit",
            arguments: {
              path: "/p/b.ts",
              edits: [{ oldText: "", newText: "bad" }],
            },
          },
        ],
        stopReason: "toolUse",
      }),
      say("done"),
    ]);
    await s.run();
    const results = s.runner
      .getTranscript()
      .filter((message) => message.role === "toolResult")
      .map(textOf);
    expect(
      results.filter((text) => text.includes("reminder from r")),
    ).toHaveLength(1);
  });
});

describe("what fired is kept with the session", () => {
  it("saves after a trigger and restores it, so a reopened session does not fire again", async () => {
    const store = memoryStore();
    const forbidden = rule(`    checks: [{regex: 'forbidden'}]\n`);
    const first = await setup(forbidden, [say("forbidden"), say("clean")], {
      store,
    });
    await first.run();
    expect(store.saved.at(-1)).toMatchObject({ injected: { r: 0 } });

    const reopened = await setup(forbidden, [say("forbidden is fine now")], {
      store,
    });
    await reopened.run();
    expect(reopened.interrupted).toEqual([]);
    expect(reopened.akhook.streams.snapshot().injected).toEqual({ r: 0 });
  });

  it("counts completed turns for the repeat gap across a reopen", async () => {
    const store = memoryStore();
    const after = rule(
      `    checks: [{regex: 'forbidden'}]\n    repeat_mode: after-gap\n    repeat_gap: 1\n`,
    );
    const first = await setup(after, [say("forbidden"), say("clean")], {
      store,
    });
    await first.run();
    expect(store.saved.at(-1)!.turns).toBe(1);
    const reopened = await setup(
      after,
      [say("forbidden"), say("clean again")],
      { store },
    );
    await reopened.run();
    expect(reopened.interrupted).toEqual(["r"]);
  });
});

describe("configuration changes apply while the session runs", () => {
  it("a rule added to the host's configuration is in force on the next frame", async () => {
    let text = "version: 1\nrules: []\n";
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([say("forbidden"), say("forbidden"), say("fine")], {
      chunkSize: 3,
    });
    const runner = new Runner(kernel, { models: fake });
    const akhook = new AkhookSession({
      cwd: undefined,
      fallbackRoot: "/project",
      ask: undefined,
      userConfigPath: "/nonexistent/akhook.yml",
      additional: () => [{ name: "t", text }],
    });
    await akhook.attach({ runner, kernel });
    const interrupted: string[] = [];
    kernelOn(kernel.ctx)("generation:interrupted", (event) => {
      interrupted.push(event.source ?? "");
    });
    kernel.inject(userMsg("one"));
    await runner.run();
    expect(interrupted).toEqual([]);
    text = `version: 1\nrules:\n${rule("    checks: [{regex: 'forbidden'}]\n")}`;
    kernel.inject(userMsg("two"));
    await runner.run();
    expect(interrupted).toEqual(["r"]);
  });
});
