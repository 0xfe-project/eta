/**
 * Tool-call rules as the session's tool middleware: deny, ask through the ask channel, the
 * approval list as the same mechanism, and the failures that must never let a call through.
 */
import type { AskResponse } from "@eta/harness";
import { Kernel } from "@eta/core";
import { AskRegistry } from "@eta/harness";
import { describe, expect, it } from "vitest";
import { AkhookSession } from "../src";

interface Setup {
  yaml?: string;
  /** What the human answers; absent means nobody can be asked. */
  answer?: (question: string, options: string[] | undefined) => AskResponse;
  approvals?: (name: string) => boolean | Promise<boolean>;
}

function setup(options: Setup = {}) {
  const kernel = Kernel.create({
    config: { model: { provider: "p", modelId: "m" } },
  });
  const asked: {
    id: string;
    question: string;
    options: string[] | undefined;
  }[] = [];
  const ask =
    options.answer === undefined
      ? undefined
      : new AskRegistry({
          headless: async (payload) => {
            asked.push({
              id: payload.questionId,
              question: payload.question,
              options: payload.options,
            });
            return options.answer!(payload.question, payload.options);
          },
        });
  const ran: string[] = [];
  for (const name of ["bash", "edit", "write", "read"]) {
    kernel.tools.register({
      name,
      execute: () => {
        ran.push(name);
        return { content: [{ type: "text", text: `${name} done` }] };
      },
    });
  }
  const akhook = new AkhookSession({
    cwd: "/project",
    ask,
    userConfigPath: "/nonexistent/akhook.yml",
    additional: () => [
      { name: "t", text: options.yaml ?? "version: 1\nrules: []\n" },
    ],
    ...(options.approvals === undefined
      ? {}
      : { approvals: options.approvals }),
  });
  kernel.tools.use(akhook.middleware);
  const call = (name: string, args: unknown, id = "c1") =>
    kernel.tools.execute(name, args, { turn: 1, toolCallId: id });
  return { kernel, call, ran, asked };
}

const allow = (): AskResponse => ({ kind: "selection", selections: ["allow"] });
const deny = (): AskResponse => ({ kind: "selection", selections: ["deny"] });

const RULES = `version: 1
rules:
  - id: no-force-push
    on: shell_exec
    checks: [{argv: [git, push, --force]}]
    message: do not force push
  - id: push
    on: shell_exec
    action: ask
    checks: [{argv: [git, push]}]
    message: pushing needs a person
  - id: no-dbg
    on: file_change
    paths: ["**/*.rs"]
    checks: [{regex: 'dbg!'}]
    message: remove dbg
`;

describe("deny", () => {
  it("blocks the call, names the rule and its message, and never runs the tool", async () => {
    const s = setup({ yaml: RULES });
    const result = await s.call("bash", { command: "git push --force" });
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain("no-force-push");
    expect((result as { content: string }).content).toContain(
      "do not force push",
    );
    expect(s.ran).toEqual([]);
  });

  it("works for the edit and write tools through their file_change candidate", async () => {
    const s = setup({ yaml: RULES });
    expect(
      await s.call("write", { path: "src/a.rs", content: "dbg!(x);" }),
    ).toMatchObject({ isError: true });
    expect(
      await s.call("edit", {
        path: "src/a.rs",
        edits: [{ oldText: "a", newText: "dbg!(a)" }],
      }),
    ).toMatchObject({ isError: true });
    expect(s.ran).toEqual([]);
    await s.call("write", { path: "src/a.rs", content: "fine();" });
    expect(s.ran).toEqual(["write"]);
  });

  it("lets calls no rule matches through untouched", async () => {
    const s = setup({ yaml: RULES });
    expect(await s.call("bash", { command: "ls" })).toEqual({
      content: [{ type: "text", text: "bash done" }],
    });
  });
});

describe("ask", () => {
  it("puts the question on the ask channel, with the rule's message, and runs the tool on allow", async () => {
    const s = setup({ yaml: RULES, answer: allow });
    await s.call("bash", { command: "git push origin main" }, "call-7");
    expect(s.ran).toEqual(["bash"]);
    expect(s.asked).toEqual([
      {
        id: "call-7",
        question: expect.stringContaining("push: pushing needs a person"),
        options: ["allow", "deny"],
      },
    ]);
    expect(s.asked[0]!.question).toContain("git push origin main");
  });

  it("blocks when the user says no, and says so to the model", async () => {
    const s = setup({ yaml: RULES, answer: deny });
    const result = await s.call("bash", { command: "git push" });
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining("the user did not approve `bash`"),
    });
    expect(s.ran).toEqual([]);
  });

  it("a declined or cancelled question (none) is a no", async () => {
    const s = setup({ yaml: RULES, answer: () => ({ kind: "none" }) });
    expect(await s.call("bash", { command: "git push" })).toMatchObject({
      isError: true,
    });
  });

  it("without an ask channel, the call is refused rather than run", async () => {
    const s = setup({ yaml: RULES });
    const result = await s.call("bash", { command: "git push" });
    expect((result as { content: string }).content).toContain(
      "this session has no way to ask",
    );
    expect(s.ran).toEqual([]);
  });

  it("a denial outranks a question: no question is asked", async () => {
    const s = setup({ yaml: RULES, answer: allow });
    await s.call("bash", { command: "git push --force" });
    expect(s.asked).toEqual([]);
    expect(s.ran).toEqual([]);
  });
});

describe("the approval list is the same mechanism", () => {
  it("a listed tool asks, with the question the inbox has always shown", async () => {
    const s = setup({ answer: allow, approvals: (name) => name === "bash" });
    await s.call("bash", { command: "ls" }, "c9");
    expect(s.asked).toEqual([
      {
        id: "c9",
        question: 'Run the `bash` tool with {"command":"ls"}?',
        options: ["allow", "deny"],
      },
    ]);
    await s.call("read", { path: "x" });
    expect(s.asked).toHaveLength(1);
  });

  it("a call that a rule and the list both ask about is one question", async () => {
    const s = setup({ yaml: RULES, answer: allow, approvals: () => true });
    await s.call("bash", { command: "git push" }, "c2");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.question).toContain("push: pushing needs a person");
    expect(s.asked[0]!.question).toContain("Run the `bash` tool");
  });

  it("a list that cannot be read refuses the call", async () => {
    const s = setup({
      answer: allow,
      approvals: () => {
        throw new Error("database is locked");
      },
    });
    const result = await s.call("bash", { command: "ls" });
    expect((result as { content: string }).content).toContain(
      "database is locked",
    );
    expect(s.ran).toEqual([]);
  });

  it("a listed tool with nobody to ask is refused", async () => {
    const s = setup({ approvals: () => true });
    expect(await s.call("bash", { command: "ls" })).toMatchObject({
      isError: true,
    });
  });
});

describe("failing closed", () => {
  it("a configuration that cannot be read refuses every call, with the reason", async () => {
    const s = setup({
      yaml: "version: 1\nrules:\n  - id: a\n    on: shell_exec\n",
    });
    const result = await s.call("read", { path: "x" });
    expect((result as { content: string }).content).toMatch(
      /akhook could not check it.*checks cannot be empty/,
    );
    expect(s.ran).toEqual([]);
  });

  it("a checker that fails refuses the call", async () => {
    const s = setup({
      yaml: `version: 1
rules:
  - id: lint
    on: shell_exec
    checks: [{command: {argv: [/nonexistent/checker]}}]
    message: m
`,
    });
    const result = await s.call("bash", { command: "ls" });
    expect((result as { content: string }).content).toContain(
      "checker for lint failed",
    );
    expect(s.ran).toEqual([]);
  });

  it("a configuration that is fixed applies to the next call", async () => {
    let yaml = "version: 1\nrules: [oops";
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    kernel.tools.register({ name: "read", execute: () => "ok" });
    const akhook = new AkhookSession({
      cwd: undefined,
      fallbackRoot: "/project",
      ask: undefined,
      userConfigPath: "/nonexistent/akhook.yml",
      additional: () => [{ name: "t", text: yaml }],
    });
    kernel.tools.use(akhook.middleware);
    const call = () =>
      kernel.tools.execute("read", {}, { turn: 1, toolCallId: "c" });
    expect(await call()).toMatchObject({ isError: true });
    yaml = "version: 1\nrules: []";
    expect(await call()).toBe("ok");
  });
});
