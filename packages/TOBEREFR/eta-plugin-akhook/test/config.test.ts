/**
 * The configuration file: its structure as akhook defines it, and how layers merge.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  additionalConfigPathsFromEnv,
  ConfigError,
  loadConfig,
  parseConfig,
} from "../src/config";
import { RuleSet } from "../src/rules";

const dirs: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "akhook-config-"));
  dirs.push(root);
  const write = (relative: string, text: string): string => {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return { root, write, user: join(root, "user", "akhook.yml") };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const rule = (id: string, message = id) =>
  `  - id: ${id}\n    on: shell_exec\n    checks:\n      - regex: 'x'\n    message: ${message}\n`;

describe("parsing", () => {
  it("reads every field of the format", () => {
    const config = parseConfig(
      `
version: 1
presets: [omp]
disabled_rules: [omp/rs-box-leak]
ask_instruction: run {request_id}
shell_tools:
  run_shell: command
rules:
  - id: a
    on: file_change
    paths: ["**/*.rs"]
    actions: [create, modify]
    checks:
      - regex: 'Box::leak\\('
      - ast: {language: rust, pattern: 'Box::leak($V)'}
    message: m
  - id: b
    on: shell_exec
    action: ask
    checks:
      - argv: [git, push]
      - argv: [gh, [pr, issue], [merge, close]]
    message: m
  - id: c
    on: shell_exec
    checks: [{command: {argv: [./hooks/lint], timeout_ms: 100}}]
    decide: {argv: [/opt/decide]}
    message: m
  - id: d
    on: tool_call
    tools: ["mcp__*"]
    checks: [{regex: '"repo":"prod"'}]
    message: m
  - id: e
    on: prompt_submit
    run: {argv: [/opt/recall]}
`,
      "test.yml",
    );
    expect(config.presets).toEqual(["omp"]);
    expect(config.shell_tools).toEqual({ run_shell: "command" });
    expect(config.ask_instruction).toBe("run {request_id}");
    expect(config.rules.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(config.rules[2]!.decide).toEqual({
      argv: ["/opt/decide"],
      timeout_ms: 5000,
    });
    expect(config.rules[1]!.checks[1]).toEqual({
      argv: ["gh", ["pr", "issue"], ["merge", "close"]],
    });
  });

  it("is strict: unknown fields, a missing or wrong version, bad types", () => {
    expect(() => parseConfig("version: 2", "t")).toThrow(
      /unsupported config version 2/,
    );
    expect(() => parseConfig("rules: []", "t")).toThrow(/version/);
    expect(() => parseConfig("version: 1\nbogus: 1", "t")).toThrow(
      /unknown field `bogus`/,
    );
    expect(() =>
      parseConfig(
        "version: 1\nrules:\n  - id: a\n    on: shell_exec\n    nope: 1",
        "t",
      ),
    ).toThrow(/unknown field `nope`/);
    expect(() =>
      parseConfig("version: 1\nrules:\n  - id: ' '\n    on: shell_exec", "t"),
    ).toThrow(/id must not be blank/);
    expect(() =>
      parseConfig("version: 1\nrules:\n  - id: a\n    on: sometimes", "t"),
    ).toThrow(/one of/);
    expect(() =>
      parseConfig(
        "version: 1\nrules:\n  - id: a\n    on: shell_exec\n    checks: [{regex: x, argv: [y]}]",
        "t",
      ),
    ).toThrow(/exactly one/);
    expect(() => parseConfig("version: [", "t")).toThrow(ConfigError);
  });

  it("accepts the stream rule kind and its fields", () => {
    const config = parseConfig(
      `version: 1
rules:
  - id: s
    on: stream
    scope: ["text", "tool:edit(*.ts)"]
    interrupt_mode: prose-only
    repeat_mode: after-gap
    repeat_gap: 3
    checks: [{regex: 'x'}]
    message: m
`,
      "t",
    );
    expect(config.rules[0]).toMatchObject({
      on: "stream",
      scope: ["text", "tool:edit(*.ts)"],
      interrupt_mode: "prose-only",
      repeat_mode: "after-gap",
      repeat_gap: 3,
    });
    expect(() =>
      parseConfig(
        "version: 1\nrules:\n  - id: s\n    on: stream\n    interrupt_mode: sometimes",
        "t",
      ),
    ).toThrow(/interrupt_mode/);
  });
});

describe("merging layers", () => {
  it("project overrides user overrides preset, by id", () => {
    const w = workspace();
    w.write(
      "user/akhook.yml",
      `version: 1\nrules:\n${rule("a", "from-user")}${rule("only-user")}`,
    );
    w.write(
      "proj/.akhook.yml",
      `version: 1\nrules:\n${rule("a", "from-project")}`,
    );
    const loaded = loadConfig({
      cwd: join(w.root, "proj"),
      userConfigPath: w.user,
    });
    expect(loaded.rules.map((r) => [r.id, r.message])).toEqual([
      ["a", "from-project"],
      ["only-user", "only-user"],
    ]);
    expect(loaded.root).toBe(join(w.root, "proj"));
  });

  it("finds the nearest .akhook.yml from a subdirectory", () => {
    const w = workspace();
    w.write("proj/.akhook.yml", `version: 1\nrules:\n${rule("a")}`);
    mkdirSync(join(w.root, "proj/src/deep"), { recursive: true });
    const loaded = loadConfig({
      cwd: join(w.root, "proj/src/deep"),
      userConfigPath: w.user,
    });
    expect(loaded.rules.map((r) => r.id)).toEqual(["a"]);
    expect(loaded.root).toBe(join(w.root, "proj"));
  });

  it("presets are off until asked for; disabled_rules removes after merging", () => {
    const w = workspace();
    w.write("proj/.akhook.yml", `version: 1\nrules:\n${rule("a")}`);
    expect(
      loadConfig({ cwd: join(w.root, "proj"), userConfigPath: w.user }).rules,
    ).toHaveLength(1);

    w.write(
      "proj/.akhook.yml",
      `version: 1\npresets: [omp]\ndisabled_rules: [omp/rs-box-leak, a]\nrules:\n${rule("a")}${rule("b")}`,
    );
    const ids = loadConfig({
      cwd: join(w.root, "proj"),
      userConfigPath: w.user,
    }).rules.map((r) => r.id);
    expect(ids).toContain("omp/ts-no-any");
    expect(ids).not.toContain("omp/rs-box-leak");
    expect(ids).not.toContain("a");
    expect(ids).toContain("b");
    expect(ids).toHaveLength(27 - 1 + 1);
  });

  it("an unknown preset is an error", () => {
    const w = workspace();
    w.write("proj/.akhook.yml", "version: 1\npresets: [nope]");
    expect(() =>
      loadConfig({ cwd: join(w.root, "proj"), userConfigPath: w.user }),
    ).toThrow(/unknown preset nope/);
  });

  it("additional configs come after, and earlier layers cannot disable or replace their rules", () => {
    const w = workspace();
    w.write(
      "proj/.akhook.yml",
      `version: 1\ndisabled_rules: [host-rule]\nrules:\n${rule("host-rule", "project override")}${rule("p")}`,
    );
    const extra = w.write(
      "extra.yml",
      `version: 1\nrules:\n${rule("host-rule", "from-host")}`,
    );
    const loaded = loadConfig({
      cwd: join(w.root, "proj"),
      userConfigPath: w.user,
      additional: [{ path: extra }],
    });
    expect(loaded.rules.find((r) => r.id === "host-rule")!.message).toBe(
      "from-host",
    );
    expect(loaded.rules.map((r) => r.id)).toContain("p");
  });

  it("only an additional config can disable an additional rule, and a later one wins", () => {
    const w = workspace();
    const first = w.write(
      "one.yml",
      `version: 1\nrules:\n${rule("x", "one")}${rule("y")}`,
    );
    const second = w.write(
      "two.yml",
      `version: 1\ndisabled_rules: [y]\nrules:\n${rule("x", "two")}`,
    );
    const loaded = loadConfig({
      cwd: w.root,
      userConfigPath: w.user,
      additional: [{ path: first }, { path: second }],
    });
    expect(loaded.rules.map((r) => [r.id, r.message])).toEqual([["x", "two"]]);
  });

  it("host text is a layer like a file", () => {
    const w = workspace();
    const loaded = loadConfig({
      cwd: w.root,
      userConfigPath: w.user,
      additional: [
        { name: "environment", text: `version: 1\nrules:\n${rule("env")}` },
      ],
    });
    expect(loaded.rules.map((r) => r.id)).toEqual(["env"]);
  });

  it("an additional file that is not there is a configuration error", () => {
    const w = workspace();
    expect(() =>
      loadConfig({
        cwd: w.root,
        userConfigPath: w.user,
        additional: [{ path: join(w.root, "missing.yml") }],
      }),
    ).toThrow(/additional config .* not found/);
  });

  it("shell_tools merge with later layers winning; ask_instruction too", () => {
    const w = workspace();
    w.write(
      "user/akhook.yml",
      "version: 1\nask_instruction: user\nshell_tools: {run_shell: command, other: cmd}",
    );
    w.write(
      "proj/.akhook.yml",
      "version: 1\nask_instruction: project\nshell_tools: {run_shell: script}",
    );
    const loaded = loadConfig({
      cwd: join(w.root, "proj"),
      userConfigPath: w.user,
    });
    expect(loaded.shellTools).toEqual({ run_shell: "script", other: "cmd" });
    expect(loaded.askInstruction).toBe("project");
  });

  it("reports the files it read, so a change can be noticed", () => {
    const w = workspace();
    const path = w.write("proj/.akhook.yml", "version: 1");
    const loaded = loadConfig({
      cwd: join(w.root, "proj"),
      userConfigPath: w.user,
    });
    expect(loaded.files).toContain(path);
    expect(loaded.files).toContain(w.user);
  });
});

describe("the environment's additional paths", () => {
  it("splits AKHOOK_ADDITIONAL_CONFIG_PATH as a path list", () => {
    expect(additionalConfigPathsFromEnv({})).toEqual([]);
    expect(
      additionalConfigPathsFromEnv({
        AKHOOK_ADDITIONAL_CONFIG_PATH: "/a.yml::/b.yml",
      }),
    ).toEqual([{ path: "/a.yml" }, { path: "/b.yml" }]);
  });
});

describe("validation when compiled", () => {
  const compile = (body: string) =>
    new RuleSet(
      loadConfig({
        cwd: "/nonexistent-akhook",
        project: false,
        userConfigPath: "/nonexistent-akhook/user.yml",
        additional: [{ name: "t", text: `version: 1\nrules:\n${body}` }],
      }),
    );

  it.each([
    [
      "no checks",
      "  - id: a\n    on: shell_exec\n    message: m\n",
      /checks cannot be empty/,
    ],
    [
      "no message",
      "  - id: a\n    on: shell_exec\n    checks: [{regex: x}]\n",
      /message is required/,
    ],
    [
      "paths without file_change",
      "  - id: a\n    on: shell_exec\n    paths: ['*']\n    checks: [{regex: x}]\n    message: m\n",
      /paths and actions require file_change/,
    ],
    [
      "tools without tool_call",
      "  - id: a\n    on: shell_exec\n    tools: ['*']\n    checks: [{regex: x}]\n    message: m\n",
      /tools requires tool_call/,
    ],
    [
      "argv outside shell_exec",
      "  - id: a\n    on: file_change\n    checks: [{argv: [x]}]\n    message: m\n",
      /argv is not allowed/,
    ],
    [
      "ast outside file_change",
      "  - id: a\n    on: shell_exec\n    checks: [{ast: {pattern: x}}]\n    message: m\n",
      /ast is not allowed/,
    ],
    [
      "action and decide",
      "  - id: a\n    on: shell_exec\n    action: ask\n    decide: {argv: [x]}\n    checks: [{regex: x}]\n    message: m\n",
      /cannot both be set/,
    ],
    [
      "bad regex",
      "  - id: a\n    on: shell_exec\n    checks: [{regex: '('}]\n    message: m\n",
      /invalid regex/,
    ],
    [
      "bad ast language",
      "  - id: a\n    on: file_change\n    checks: [{ast: {language: klingon, pattern: x}}]\n    message: m\n",
      /invalid AST language/,
    ],
    [
      "lifecycle with checks",
      "  - id: a\n    on: stop\n    run: {argv: [x]}\n    checks: [{regex: x}]\n",
      /only take run/,
    ],
    ["lifecycle without run", "  - id: a\n    on: prompt_submit\n", /need run/],
    [
      "run on a tool rule",
      "  - id: a\n    on: shell_exec\n    run: {argv: [x]}\n    checks: [{regex: x}]\n    message: m\n",
      /run is for/,
    ],
    [
      "stream fields on a tool rule",
      "  - id: a\n    on: shell_exec\n    scope: [text]\n    checks: [{regex: x}]\n    message: m\n",
      /for stream rules/,
    ],
    [
      "stream with action",
      "  - id: a\n    on: stream\n    action: ask\n    checks: [{regex: x}]\n    message: m\n",
      /stream rules take/,
    ],
    [
      "stream with argv",
      "  - id: a\n    on: stream\n    checks: [{argv: [x]}]\n    message: m\n",
      /argv is not allowed/,
    ],
    [
      "stream with no reachable scope",
      "  - id: a\n    on: stream\n    scope: [' ']\n    checks: [{regex: x}]\n    message: m\n",
      /scope excludes/,
    ],
  ])("%s is refused with the rule's id", (_name, body, reason) => {
    expect(() => compile(body)).toThrow(ConfigError);
    expect(() => compile(body)).toThrow(/invalid rule a/);
    expect(() => compile(body)).toThrow(reason);
  });
});
