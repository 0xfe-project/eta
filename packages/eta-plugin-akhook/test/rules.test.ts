/**
 * Tool-call rules and lifecycle rules: every kind of rule and every action.
 */
import type { Candidate } from "../src/rules";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidatesOf, introducedLines } from "../src/candidates";
import { loadConfig } from "../src/config";
import { RuleSet } from "../src/rules";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function project(yaml: string, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "akhook-rules-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    if (name.startsWith("hooks/")) chmodSync(path, 0o755);
  }
  const rules = new RuleSet(
    loadConfig({
      cwd: root,
      project: false,
      userConfigPath: join(root, "none.yml"),
      additional: [{ name: "test", text: `version: 1\n${yaml}` }],
    }),
  );
  return { root, rules };
}

const shell = (command: string): Candidate[] => [
  { type: "tool_call", name: "bash", args: { command } },
  { type: "shell_exec", command },
];
const change = (
  root: string,
  path: string,
  added: string,
  action: "create" | "modify" | "delete" = "create",
  extra: Partial<Extract<Candidate, { type: "file_change" }>> = {},
): Candidate[] => [
  {
    type: "file_change",
    path: join(root, path),
    action,
    ...(action === "delete" ? {} : { added_text: added, new_text: added }),
    ...extra,
  },
];

describe("file_change rules", () => {
  const yaml = `
rules:
  - id: no-dbg
    on: file_change
    paths: ["**/*.rs"]
    actions: [create, modify]
    checks:
      - regex: '\\bdbg!\\s*\\('
    message: remove dbg
`;

  it("matches the added text of files under the path globs, with the rule's message", async () => {
    const { root, rules } = project(yaml);
    expect(
      await rules.evaluate(change(root, "src/lib.rs", "dbg!(x);")),
    ).toEqual({
      kind: "deny",
      hits: [{ id: "no-dbg", message: "remove dbg", action: "deny" }],
    });
    expect(await rules.evaluate(change(root, "src/lib.rs", "fine();"))).toEqual(
      {
        kind: "allow",
      },
    );
    expect(
      await rules.evaluate(change(root, "src/lib.ts", "dbg!(x);")),
    ).toEqual({
      kind: "allow",
    });
  });

  it("limits by action, and never runs regex or ast on a deletion", async () => {
    const { root, rules } = project(yaml);
    expect(
      await rules.evaluate(change(root, "src/lib.rs", "", "delete")),
    ).toEqual({ kind: "allow" });
    const onlyCreate = project(yaml.replace("[create, modify]", "[create]"));
    expect(
      await onlyCreate.rules.evaluate(
        change(onlyCreate.root, "a.rs", "dbg!(x)", "modify"),
      ),
    ).toEqual({ kind: "allow" });
  });

  it("a command check still sees a deletion's path and action", async () => {
    const { root, rules } = project(
      `
rules:
  - id: guard
    on: file_change
    checks:
      - command: {argv: [./hooks/guard]}
    message: static
`,
      {
        "hooks/guard": `#!/bin/sh\ncat > /dev/null\necho '{"matched":true,"message":"dynamic"}'\n`,
      },
    );
    expect(await rules.evaluate(change(root, "x.txt", "", "delete"))).toEqual({
      kind: "deny",
      hits: [{ id: "guard", message: "dynamic", action: "deny" }],
    });
  });

  describe("ast checks look only at what the change introduces", () => {
    const ast = `
rules:
  - id: no-any
    on: file_change
    checks:
      - ast: {language: tsx, pattern: 'const $A: any = $B'}
    message: no any
`;
    it("matches new structure, found from the path when no language is given", async () => {
      const { root, rules } = project(ast.replace("language: tsx, ", ""));
      expect(
        await rules.evaluate(change(root, "a.ts", "const x: any = 1;")),
      ).toMatchObject({ kind: "deny" });
      expect(
        await rules.evaluate(change(root, "a.ts", "const x: number = 1;")),
      ).toEqual({ kind: "allow" });
    });

    it("ignores a match the old text already held", async () => {
      const { root, rules } = project(ast);
      const old = "const x: any = 1;\n";
      expect(
        await rules.evaluate(
          change(root, "a.ts", `${old}const y = 2;`, "modify", {
            old_text: old,
          }),
        ),
      ).toEqual({ kind: "allow" });
      expect(
        await rules.evaluate(
          change(root, "a.ts", `${old}const z: any = 2;`, "modify", {
            old_text: old,
          }),
        ),
      ).toMatchObject({ kind: "deny" });
    });

    it("cannot infer a language from an unknown extension: the check fails closed", async () => {
      const { root, rules } = project(ast.replace("language: tsx, ", ""));
      await expect(
        rules.evaluate(change(root, "a.weird", "const x: any = 1;")),
      ).rejects.toThrow(/cannot infer AST language/);
    });

    it("an invalid pattern is an error, not a non-match", async () => {
      const { root, rules } = project(
        ast.replace("const $A: any = $B", "a; b"),
      );
      await expect(
        rules.evaluate(change(root, "a.ts", "const x = 1;")),
      ).rejects.toThrow(/AST pattern/);
    });

    it("works for rust and go through the dynamic parsers", async () => {
      const { root, rules } = project(`
rules:
  - id: rs
    on: file_change
    checks: [{ast: {language: rust, pattern: 'Box::leak($V)'}}]
    message: m
  - id: go
    on: file_change
    checks: [{ast: {language: go, pattern: 'runtime.SetFinalizer($A, $B)'}}]
    message: m
`);
      const hit = await rules.evaluate([
        ...change(root, "a.rs", "fn f() { Box::leak(Box::new(1)); }"),
        ...change(
          root,
          "a.go",
          "package a\nfunc f(o *T) { runtime.SetFinalizer(o, nil) }",
        ),
      ]);
      expect(hit.kind === "deny" && hit.hits.map((h) => h.id)).toEqual([
        "go",
        "rs",
      ]);
    });
  });
});

describe("shell_exec rules", () => {
  const yaml = `
rules:
  - id: no-force-delete
    on: shell_exec
    checks:
      - regex: 'rm\\s+-rf\\b'
    message: confirm the scope
  - id: gh-write
    on: shell_exec
    checks:
      - argv: [gh, [pr, issue], [merge, close, comment]]
    message: gh is read-only
  - id: push
    on: shell_exec
    action: ask
    checks:
      - argv: [git, push]
    message: pushing needs a person
`;

  it("regex checks see the command text", async () => {
    const { rules } = project(yaml);
    expect(await rules.evaluate(shell("cd x && rm -rf build"))).toMatchObject({
      kind: "deny",
      hits: [{ id: "no-force-delete" }],
    });
    expect(await rules.evaluate(shell("ls"))).toEqual({ kind: "allow" });
  });

  it("argv checks see commands, not words", async () => {
    const { rules } = project(yaml);
    expect(
      await rules.evaluate(shell("gh -R a/b issue comment 3")),
    ).toMatchObject({
      kind: "deny",
      hits: [{ id: "gh-write" }],
    });
    expect(await rules.evaluate(shell("echo gh pr merge"))).toEqual({
      kind: "allow",
    });
    expect(
      await rules.evaluate(shell("(sleep 1; gh pr close 2)")),
    ).toMatchObject({
      kind: "deny",
    });
    expect(await rules.evaluate(shell("sh -c 'gh pr merge 2'"))).toMatchObject({
      kind: "deny",
    });
  });

  it("ask is its own decision, and a denial outranks a question", async () => {
    const { rules } = project(yaml);
    expect(await rules.evaluate(shell("git push origin main"))).toEqual({
      kind: "ask",
      hits: [{ id: "push", message: "pushing needs a person", action: "ask" }],
    });
    const both = await rules.evaluate(shell("git push && rm -rf x"));
    expect(both).toMatchObject({
      kind: "deny",
      hits: [{ id: "no-force-delete" }],
    });
    expect(both.kind === "deny" && both.hits).toHaveLength(1);
  });

  it("a rule that matches several candidates is reported once", async () => {
    const { rules } = project(yaml);
    const decision = await rules.evaluate([
      ...shell("rm -rf a"),
      ...shell("rm -rf b"),
    ]);
    expect(decision.kind === "deny" && decision.hits).toHaveLength(1);
  });

  it("shell_tools make a host's shell tool a shell_exec candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "akhook-rules-"));
    dirs.push(root);
    const rules = new RuleSet(
      loadConfig({
        cwd: root,
        project: false,
        userConfigPath: join(root, "none.yml"),
        additional: [
          {
            name: "t",
            text: `version: 1\nshell_tools: {run_shell: cmd}\nrules:\n  - id: g\n    on: shell_exec\n    checks: [{argv: [git, push]}]\n    message: m\n`,
          },
        ],
      }),
    );
    expect(
      await rules.evaluate([
        { type: "tool_call", name: "run_shell", args: { cmd: "git push" } },
      ]),
    ).toMatchObject({ kind: "deny" });
    expect(
      await rules.evaluate([
        { type: "tool_call", name: "other_tool", args: { cmd: "git push" } },
      ]),
    ).toEqual({ kind: "allow" });
  });
});

describe("tool_call rules", () => {
  const yaml = `
rules:
  - id: no-delete-prod
    on: tool_call
    tools: ["mcp__github__*"]
    checks:
      - regex: '"repo":"prod"'
    message: not prod
  - id: any-tool
    on: tool_call
    checks:
      - regex: 'secret'
    message: no secrets
`;
  it("limits by tool-name glob and matches the arguments' compact JSON", async () => {
    const { rules } = project(yaml);
    const call = (name: string, args: unknown): Candidate[] => [
      { type: "tool_call", name, args },
    ];
    expect(
      await rules.evaluate(call("mcp__github__delete", { repo: "prod" })),
    ).toMatchObject({ kind: "deny", hits: [{ id: "no-delete-prod" }] });
    expect(
      await rules.evaluate(call("mcp__slack__post", { repo: "prod" })),
    ).toEqual({ kind: "allow" });
    expect(
      await rules.evaluate(call("anything", { note: "my secret" })),
    ).toMatchObject({ kind: "deny", hits: [{ id: "any-tool" }] });
  });
});

describe("decide scripts", () => {
  const decide = (answer: string) =>
    project(
      `
rules:
  - id: push-protected
    on: shell_exec
    checks: [{argv: [git, push]}]
    decide: {argv: [./hooks/decide]}
    message: static message
`,
      { "hooks/decide": `#!/bin/sh\ncat > "$0.input"\necho '${answer}'\n` },
    );

  it("allow means the candidate is not a hit; deny and ask carry the script's message", async () => {
    expect(
      await decide('{"action":"allow"}').rules.evaluate(shell("git push")),
    ).toEqual({ kind: "allow" });
    expect(
      await decide(
        '{"action":"deny","message":"main is protected"}',
      ).rules.evaluate(shell("git push")),
    ).toEqual({
      kind: "deny",
      hits: [
        { id: "push-protected", message: "main is protected", action: "deny" },
      ],
    });
    expect(
      await decide('{"action":"ask"}').rules.evaluate(shell("git push")),
    ).toEqual({
      kind: "ask",
      hits: [
        { id: "push-protected", message: "static message", action: "ask" },
      ],
    });
  });

  it("is only run for candidates the checks matched, with a versioned document on stdin", async () => {
    const d = decide('{"action":"allow"}');
    await d.rules.evaluate(shell("ls"));
    expect(() => readInput(d.root)).toThrow();
    await d.rules.evaluate(shell("git push"));
    expect(JSON.parse(readInput(d.root))).toEqual({
      version: 1,
      rule_id: "push-protected",
      candidate: { type: "shell_exec", command: "git push" },
    });
  });

  it("a script that fails, times out or answers nonsense is an error", async () => {
    await expect(
      decide("not json").rules.evaluate(shell("git push")),
    ).rejects.toThrow(/invalid JSON output/);
    await expect(
      decide('{"action":"maybe"}').rules.evaluate(shell("git push")),
    ).rejects.toThrow(/allow, deny or ask/);
    const slow = project(
      `
rules:
  - id: slow
    on: shell_exec
    checks: [{regex: x}]
    decide: {argv: [./hooks/slow], timeout_ms: 100}
    message: m
`,
      { "hooks/slow": "#!/bin/sh\nsleep 5\n" },
    );
    await expect(slow.rules.evaluate(shell("x"))).rejects.toThrow(/timed out/);
    const failing = project(
      `
rules:
  - id: failing
    on: shell_exec
    checks: [{regex: x}]
    decide: {argv: [./hooks/fail]}
    message: m
`,
      { "hooks/fail": "#!/bin/sh\necho oops >&2\nexit 3\n" },
    );
    await expect(failing.rules.evaluate(shell("x"))).rejects.toThrow(
      /exited 3: oops/,
    );
  });
});

function readInput(root: string): string {
  // eslint-disable-next-line ts/no-require-imports -- a test helper
  return require("node:fs").readFileSync(
    join(root, "hooks", "decide.input"),
    "utf8",
  );
}

describe("command checks", () => {
  it("a checker may exit without reading its input, and says whether it matched", async () => {
    const { rules } = project(
      `
rules:
  - id: lint
    on: shell_exec
    checks: [{command: {argv: [./hooks/lint]}}]
    message: fix it
`,
      { "hooks/lint": `#!/bin/sh\necho '{"matched":false}'\n` },
    );
    expect(await rules.evaluate(shell("x"))).toEqual({ kind: "allow" });
  });
});

describe("lifecycle rules", () => {
  const lifecycle = (script: string, timeout = 5000) =>
    project(
      `
rules:
  - id: memory/recall
    on: prompt_submit
    run: {argv: [./hooks/run], timeout_ms: ${timeout}}
  - id: memory/capture
    on: stop
    run: {argv: [./hooks/run], timeout_ms: ${timeout}}
`,
      { "hooks/run": script },
    );

  it("prompt_submit contexts are collected in rule order, with the event's fields", async () => {
    const { rules, root } = lifecycle(
      `#!/bin/sh\ncat > "$0.in.$$"\necho '{"context":"remember this"}'\n`,
    );
    const warnings: string[] = [];
    const contexts = await rules.lifecycle(
      "prompt_submit",
      { cwd: root, session_id: "s1", prompt: "hello" },
      (m) => warnings.push(m),
    );
    expect(contexts).toEqual(["remember this"]);
    expect(warnings).toEqual([]);
  });

  it("stop rules run, and what they print is ignored", async () => {
    const { rules, root } = lifecycle(
      `#!/bin/sh\necho '{"context":"ignored"}'\n`,
    );
    expect(
      rules.hasLifecycle("stop") && rules.hasLifecycle("prompt_submit"),
    ).toBe(true);
    // The stop event produces contexts like any other; the host throws them away.
    expect(
      await rules.lifecycle("stop", {
        cwd: root,
        last_assistant_message: "bye",
      }),
    ).toEqual(["ignored"]);
  });

  it("never holds anything up: errors, timeouts and bad output add nothing and are reported", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(
      await lifecycle("#!/bin/sh\nexit 1\n").rules.lifecycle(
        "prompt_submit",
        {},
        warn,
      ),
    ).toEqual([]);
    expect(
      await lifecycle("#!/bin/sh\nsleep 5\n", 100).rules.lifecycle(
        "prompt_submit",
        {},
        warn,
      ),
    ).toEqual([]);
    expect(
      await lifecycle("#!/bin/sh\necho nonsense\n").rules.lifecycle(
        "prompt_submit",
        {},
        warn,
      ),
    ).toEqual([]);
    expect(
      await lifecycle("#!/bin/sh\necho '{}'\n").rules.lifecycle(
        "prompt_submit",
        {},
        warn,
      ),
    ).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/memory\/recall/);
  });
});

describe("candidates from eta's tools", () => {
  it("edit introduces only the lines that were not already there", () => {
    expect(introducedLines("a\nb\nc", "a\nB\nc\nd")).toBe("B\nd");
    expect(introducedLines("x\nx", "x")).toBe("");
    expect(introducedLines("", "new")).toBe("new");
  });

  it("an edit call is a modify with the new text, a write is create or modify", () => {
    const root = mkdtempSync(join(tmpdir(), "akhook-cand-"));
    dirs.push(root);
    writeFileSync(join(root, "old.ts"), "keep\nthis\n");
    const edit = candidatesOf(
      "edit",
      { path: "old.ts", edits: [{ oldText: "this", newText: "that" }] },
      root,
    );
    expect(edit).toEqual([
      { type: "tool_call", name: "edit", args: expect.anything() },
      {
        type: "file_change",
        path: join(root, "old.ts"),
        action: "modify",
        added_text: "that",
        new_text: "that",
        old_text: "this",
      },
    ]);
    const created = candidatesOf("write", { path: "n.ts", content: "x" }, root);
    expect(created[1]).toMatchObject({ action: "create", added_text: "x" });
    const rewritten = candidatesOf(
      "write",
      { path: "old.ts", content: "keep\nnew\n" },
      root,
    );
    expect(rewritten[1]).toMatchObject({ action: "modify", added_text: "new" });
    expect(candidatesOf("read", { path: "old.ts" }, root)).toHaveLength(1);
    expect(candidatesOf("bash", { command: "ls" }, root)).toHaveLength(1);
  });
});
