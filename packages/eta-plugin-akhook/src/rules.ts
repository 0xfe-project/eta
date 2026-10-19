/**
 * Rules, compiled, and the evaluation of tool-call rules (akhook's `rules.rs`).
 *
 * A configuration is validated here the way akhook validates it: a rule that cannot work is a
 * configuration error, reported with its id, never a rule that quietly matches nothing. Tool
 * rules (`file_change`, `shell_exec`, `tool_call`) are evaluated against the candidates one tool
 * call produces; lifecycle rules run a command; `stream` rules are compiled here and run by
 * `stream.ts`.
 */
import type {
  ArgvItem,
  CommandSpec,
  FileAction,
  InterruptMode,
  LoadedConfig,
  RepeatMode,
  RuleAction,
  RuleEvent,
  RuleSpec,
} from "./types";
import { isAbsolute, relative, sep } from "node:path";
import picomatch from "picomatch";
import { astMatches, languageForPath, normalizeLanguage } from "./ast";
import { CheckerError, runCommand, runJson } from "./command";
import { argvMatches, simpleCommands } from "./shell";
import { ConfigError } from "./types";

export type Candidate =
  | {
      type: "file_change";
      /** Absolute path. */
      path: string;
      action: FileAction;
      /** What the change introduces; `undefined` for a deletion. */
      added_text?: string;
      /** The whole new text of what was written (for structural checks). */
      new_text?: string;
      /** What it replaces, so a structural match that was already there is not new. */
      old_text?: string;
    }
  | { type: "shell_exec"; command: string }
  | { type: "tool_call"; name: string; args: unknown };

export interface RuleHit {
  id: string;
  message: string;
  action: RuleAction;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; hits: RuleHit[] }
  | { kind: "ask"; hits: RuleHit[] };

/** The decision hits make: any denial denies; otherwise any question asks. */
export function decisionOf(hits: RuleHit[]): Decision {
  if (hits.length === 0) return { kind: "allow" };
  const denials = hits.filter((hit) => hit.action === "deny");
  return denials.length > 0
    ? { kind: "deny", hits: denials }
    : { kind: "ask", hits };
}

const INLINE_FLAGS = /^\(\?([a-z]+)\)/;

/**
 * A rule's `regex` as a JavaScript `RegExp`. A leading inline flag group (`(?i)`, `(?ms)`) is
 * translated into native flags, the way omp does for its conditions; flags JavaScript does not
 * have are an error.
 */
export function compileRegex(pattern: string): RegExp {
  const match = INLINE_FLAGS.exec(pattern);
  if (match !== null && /^[ims]+$/.test(match[1]!)) {
    return new RegExp(
      pattern.slice(match[0].length),
      [...new Set(match[1])].join(""),
    );
  }
  return new RegExp(pattern);
}

/** A path/tool-name glob. Without a `/` a pattern matches the basename too (globset's `*`). */
export function globMatcher(glob: string): (value: string) => boolean {
  const matches = picomatch(glob, { dot: true });
  if (glob.includes("/")) return matches;
  return (value) =>
    matches(value) || matches(value.slice(value.lastIndexOf("/") + 1));
}

interface CompiledScript {
  spec: CommandSpec;
}

type CompiledCheck =
  | { kind: "regex"; regex: RegExp }
  | { kind: "argv"; argv: ArgvItem[] }
  | { kind: "ast"; language: string | undefined; pattern: string }
  | { kind: "command"; script: CompiledScript };

type Outcome =
  | { kind: "fixed"; action: RuleAction }
  | { kind: "decide"; script: CompiledScript };

interface ToolRule {
  id: string;
  event: "file_change" | "shell_exec" | "tool_call";
  paths: ((path: string) => boolean)[];
  actions: FileAction[];
  tools: ((name: string) => boolean)[];
  checks: CompiledCheck[];
  message: string;
  outcome: Outcome;
}

interface LifecycleRule {
  id: string;
  event: "prompt_submit" | "stop";
  run: CommandSpec;
}

/** One watched surface of a `stream` rule (omp's `scope`). */
export interface StreamScope {
  text: boolean;
  thinking: boolean;
  anyTool: boolean;
  tools: { name?: string; glob?: (path: string) => boolean }[];
}

export interface StreamRule {
  id: string;
  message: string;
  regexes: RegExp[];
  asts: { language: string | undefined; pattern: string }[];
  scope: StreamScope;
  /** Extra path gate for file-bearing tool calls (omp's `globs`). */
  paths: ((path: string) => boolean)[];
  interruptMode: InterruptMode | undefined;
  repeatMode: RepeatMode;
  repeatGap: number;
}

const SCOPE_TOKEN =
  /^(?:(?<prefix>tool)(?::(?<tool>[\w-]+))?|(?<bare>[\w-]+))(?:\((?<path>[^)]+)\))?$/i;

/** omp's `scope` tokens: `text`, `thinking`, `tool`, `tool:<name>`, `tool:<name>(<glob>)`. */
export function parseScope(tokens: readonly string[]): StreamScope {
  if (tokens.length === 0)
    return { text: true, thinking: false, anyTool: true, tools: [] };
  const scope: StreamScope = {
    text: false,
    thinking: false,
    anyTool: false,
    tools: [],
  };
  for (const raw of tokens) {
    const token = raw.trim();
    const lower = token.toLowerCase();
    if (token === "") continue;
    if (lower === "text") scope.text = true;
    else if (lower === "thinking") scope.thinking = true;
    else if (lower === "tool" || lower === "toolcall") scope.anyTool = true;
    else {
      const groups = SCOPE_TOKEN.exec(token)?.groups;
      if (groups === undefined) throw new Error(`invalid scope token ${raw}`);
      const name = (
        groups.tool ?? (groups.prefix === undefined ? groups.bare : undefined)
      )?.toLowerCase();
      const glob = groups.path?.trim();
      if (name === undefined && glob === undefined) scope.anyTool = true;
      else
        scope.tools.push({
          ...(name === undefined ? {} : { name }),
          ...(glob === undefined ? {} : { glob: globMatcher(glob) }),
        });
    }
  }
  if (
    !scope.text &&
    !scope.thinking &&
    !scope.anyTool &&
    scope.tools.length === 0
  )
    throw new Error("scope excludes every output");
  return scope;
}

function script(spec: CommandSpec): CompiledScript {
  if (spec.argv.length === 0 || spec.argv[0] === "" || spec.timeout_ms <= 0)
    throw new Error("command requires argv and a positive timeout_ms");
  return { spec };
}

function compileGlobs(
  globs: readonly string[],
  what: string,
): ((value: string) => boolean)[] {
  return globs.map((glob) => {
    try {
      return globMatcher(glob);
    } catch (error) {
      throw new Error(
        `invalid ${what} glob ${glob}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function compileChecks(
  spec: RuleSpec,
  allowed: readonly string[],
): CompiledCheck[] {
  return spec.checks.map((check): CompiledCheck => {
    const kind = Object.keys(check)[0]!;
    if (!allowed.includes(kind)) throw new Error(`${kind} is not allowed here`);
    if ("regex" in check) {
      try {
        return { kind: "regex", regex: compileRegex(check.regex) };
      } catch (error) {
        throw new Error(
          `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if ("ast" in check) {
      const language =
        check.ast.language === undefined
          ? undefined
          : normalizeLanguage(check.ast.language);
      if (check.ast.language !== undefined && language === undefined)
        throw new Error(`invalid AST language: ${check.ast.language}`);
      return { kind: "ast", language, pattern: check.ast.pattern };
    }
    if ("argv" in check) {
      if (check.argv.length === 0) throw new Error("argv cannot be empty");
      return { kind: "argv", argv: check.argv };
    }
    return { kind: "command", script: script(check.command) };
  });
}

/** eta's shell tool, which `shell_tools` need not name. */
const BUILTIN_SHELL_TOOLS: Readonly<Record<string, string>> = {
  bash: "command",
};

/** Everything a configuration says, validated and ready to run. */
export class RuleSet {
  readonly root: string;
  readonly shellTools: Readonly<Record<string, string>>;
  readonly streamRules: readonly StreamRule[];
  private readonly toolRules: ToolRule[] = [];
  private readonly lifecycleRules: LifecycleRule[] = [];

  constructor(config: LoadedConfig) {
    this.root = config.root;
    this.shellTools = { ...BUILTIN_SHELL_TOOLS, ...config.shellTools };
    const stream: StreamRule[] = [];
    for (const spec of config.rules) {
      try {
        const compiled = this.compile(spec);
        if (compiled !== undefined) stream.push(compiled);
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        throw new ConfigError(
          `invalid rule ${spec.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.streamRules = stream;
  }

  /** Compile one rule; a stream rule is returned, the others are kept in place. */
  private compile(spec: RuleSpec): StreamRule | undefined {
    const event: RuleEvent = spec.on;
    if (event === "prompt_submit" || event === "stop") {
      if (
        spec.checks.length > 0 ||
        spec.paths.length > 0 ||
        spec.actions.length > 0 ||
        spec.tools.length > 0 ||
        spec.message !== undefined ||
        spec.action !== undefined ||
        spec.decide !== undefined ||
        spec.scope.length > 0 ||
        spec.interrupt_mode !== undefined ||
        spec.repeat_mode !== undefined ||
        spec.repeat_gap !== undefined
      )
        throw new Error("prompt_submit and stop rules only take run");
      if (spec.run === undefined)
        throw new Error("prompt_submit and stop rules need run");
      this.lifecycleRules.push({
        id: spec.id,
        event,
        run: script(spec.run).spec,
      });
      return undefined;
    }
    if (spec.run !== undefined)
      throw new Error("run is for prompt_submit and stop rules");
    if (spec.checks.length === 0) throw new Error("checks cannot be empty");
    if (spec.message === undefined) throw new Error("message is required");

    if (event === "stream") return this.compileStream(spec, spec.message);

    if (
      spec.scope.length > 0 ||
      spec.interrupt_mode !== undefined ||
      spec.repeat_mode !== undefined ||
      spec.repeat_gap !== undefined
    )
      throw new Error(
        "scope, interrupt_mode, repeat_mode and repeat_gap are for stream rules",
      );
    if (
      event !== "file_change" &&
      (spec.paths.length > 0 || spec.actions.length > 0)
    )
      throw new Error("paths and actions require file_change");
    if (event !== "tool_call" && spec.tools.length > 0)
      throw new Error("tools requires tool_call");
    const allowed =
      event === "shell_exec"
        ? ["regex", "argv", "command"]
        : event === "file_change"
          ? ["regex", "ast", "command"]
          : ["regex", "command"];
    const checks = compileChecks(spec, allowed);
    if (spec.action !== undefined && spec.decide !== undefined)
      throw new Error("action and decide cannot both be set");
    const outcome: Outcome =
      spec.decide === undefined
        ? { kind: "fixed", action: spec.action ?? "deny" }
        : { kind: "decide", script: script(spec.decide) };
    this.toolRules.push({
      id: spec.id,
      event,
      paths: compileGlobs(spec.paths, "path"),
      actions: spec.actions,
      tools: compileGlobs(spec.tools, "tool"),
      checks,
      message: spec.message,
      outcome,
    });
    return undefined;
  }

  private compileStream(spec: RuleSpec, message: string): StreamRule {
    if (
      spec.actions.length > 0 ||
      spec.tools.length > 0 ||
      spec.action !== undefined ||
      spec.decide !== undefined
    )
      throw new Error(
        "stream rules take scope, paths and checks, not actions, tools, action or decide",
      );
    const checks = compileChecks(spec, ["regex", "ast"]);
    return {
      id: spec.id,
      message,
      regexes: checks.flatMap((check) =>
        check.kind === "regex" ? [check.regex] : [],
      ),
      asts: checks.flatMap((check) =>
        check.kind === "ast"
          ? [{ language: check.language, pattern: check.pattern }]
          : [],
      ),
      scope: parseScope(spec.scope),
      paths: compileGlobs(spec.paths, "path"),
      interruptMode: spec.interrupt_mode,
      repeatMode: spec.repeat_mode ?? "once",
      repeatGap: spec.repeat_gap ?? 10,
    };
  }

  /** Whether any tool or lifecycle rule exists (the middleware has nothing to do without). */
  get hasToolRules(): boolean {
    return this.toolRules.length > 0;
  }

  /** The candidates of a call, plus a `shell_exec` for each call of a configured shell tool. */
  expand(candidates: readonly Candidate[]): Candidate[] {
    const all = [...candidates];
    for (const candidate of candidates) {
      if (candidate.type !== "tool_call") continue;
      const field = this.shellTools[candidate.name];
      if (field === undefined) continue;
      const args = candidate.args;
      const command =
        typeof args === "object" && args !== null
          ? (args as Record<string, unknown>)[field]
          : undefined;
      if (typeof command === "string")
        all.push({ type: "shell_exec", command });
    }
    return all;
  }

  /** Evaluate the tool rules against one call's candidates. */
  async evaluate(candidates: readonly Candidate[]): Promise<Decision> {
    const hits: RuleHit[] = [];
    const seen = new Set<string>();
    const all = this.expand(candidates);
    for (const rule of this.toolRules) {
      for (const candidate of all) {
        if (!this.applies(rule, candidate)) continue;
        const found = await this.check(rule, candidate);
        if (found === undefined) continue;
        let action: RuleAction;
        let message = found;
        if (rule.outcome.kind === "fixed") {
          action = rule.outcome.action;
        } else {
          const decided = await this.decide(
            rule,
            rule.outcome.script,
            candidate,
          );
          if (decided === "allow") continue;
          action = decided.action;
          message = decided.message ?? message;
        }
        if (!seen.has(rule.id)) {
          seen.add(rule.id);
          hits.push({ id: rule.id, message, action });
        }
        break;
      }
    }
    return decisionOf(hits);
  }

  private relative(path: string): string {
    const rel = isAbsolute(path) ? relative(this.root, path) : path;
    return (rel.startsWith("..") ? path : rel).split(sep).join("/");
  }

  private applies(rule: ToolRule, candidate: Candidate): boolean {
    if (rule.event === "shell_exec") return candidate.type === "shell_exec";
    if (rule.event === "tool_call") {
      return (
        candidate.type === "tool_call" &&
        (rule.tools.length === 0 ||
          rule.tools.some((matches) => matches(candidate.name)))
      );
    }
    if (candidate.type !== "file_change") return false;
    const path = this.relative(candidate.path);
    return (
      (rule.paths.length === 0 ||
        rule.paths.some((matches) => matches(path))) &&
      (rule.actions.length === 0 || rule.actions.includes(candidate.action))
    );
  }

  /** The message of the first check that matches, or `undefined`. */
  private async check(
    rule: ToolRule,
    candidate: Candidate,
  ): Promise<string | undefined> {
    for (const check of rule.checks) {
      if (check.kind === "command") {
        const answer = (await runJson(
          rule.id,
          check.script.spec,
          {
            version: 1,
            rule_id: rule.id,
            candidate: this.forScript(candidate),
          },
          this.root,
        )) as { matched?: unknown; message?: unknown };
        if (typeof answer.matched !== "boolean")
          throw new CheckerError(rule.id, "output needs a boolean `matched`");
        if (answer.matched)
          return typeof answer.message === "string"
            ? answer.message
            : rule.message;
        continue;
      }
      if (await this.matches(rule, check, candidate)) return rule.message;
    }
    return undefined;
  }

  private async matches(
    rule: ToolRule,
    check: Exclude<CompiledCheck, { kind: "command" }>,
    candidate: Candidate,
  ): Promise<boolean> {
    switch (check.kind) {
      case "regex":
        if (candidate.type === "shell_exec")
          return check.regex.test(candidate.command);
        if (candidate.type === "tool_call")
          return check.regex.test(JSON.stringify(candidate.args ?? null));
        return (
          candidate.added_text !== undefined &&
          check.regex.test(candidate.added_text)
        );
      case "argv": {
        if (candidate.type !== "shell_exec") return false;
        const commands = await simpleCommands(candidate.command);
        return commands.some((words) => argvMatches(check.argv, words));
      }
      case "ast": {
        if (
          candidate.type !== "file_change" ||
          candidate.new_text === undefined
        )
          return false;
        const language = check.language ?? languageForPath(candidate.path);
        if (language === undefined)
          throw new CheckerError(
            rule.id,
            `cannot infer AST language for ${candidate.path}`,
          );
        const found = await astMatches(
          language,
          check.pattern,
          candidate.new_text,
        );
        const before = candidate.old_text ?? "";
        // Only what the change introduces: a match the old text already held is not new.
        return found.some((text) => !before.includes(text));
      }
    }
  }

  private forScript(candidate: Candidate): unknown {
    if (candidate.type !== "file_change") return candidate;
    return {
      type: "file_change",
      path: this.relative(candidate.path),
      action: candidate.action,
      ...(candidate.added_text === undefined
        ? {}
        : { added_text: candidate.added_text }),
    };
  }

  private async decide(
    rule: ToolRule,
    decide: CompiledScript,
    candidate: Candidate,
  ): Promise<"allow" | { action: RuleAction; message?: string }> {
    const answer = (await runJson(
      rule.id,
      decide.spec,
      { version: 1, rule_id: rule.id, candidate: this.forScript(candidate) },
      this.root,
    )) as { action?: unknown; message?: unknown };
    const message =
      typeof answer.message === "string" ? answer.message : undefined;
    if (answer.action === "allow") return "allow";
    if (answer.action === "deny" || answer.action === "ask")
      return {
        action: answer.action,
        ...(message === undefined ? {} : { message }),
      };
    throw new CheckerError(
      rule.id,
      "decide output needs action allow, deny or ask",
    );
  }

  /**
   * Run the lifecycle rules of `event` in order and return the context they add. A failing
   * command never holds anything up: it is reported through `warn` and adds nothing.
   */
  async lifecycle(
    event: "prompt_submit" | "stop",
    data: Record<string, unknown>,
    warn: (message: string) => void = () => undefined,
  ): Promise<string[]> {
    const contexts: string[] = [];
    for (const rule of this.lifecycleRules) {
      if (rule.event !== event) continue;
      try {
        const stdout = await runCommand(
          rule.id,
          rule.run,
          JSON.stringify({ version: 1, rule_id: rule.id, event, ...data }),
          this.root,
        );
        if (stdout.trim() === "") continue;
        const parsed = JSON.parse(stdout) as { context?: unknown };
        if (typeof parsed.context === "string" && parsed.context.trim() !== "")
          contexts.push(parsed.context);
      } catch (error) {
        warn(
          `akhook: ${rule.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return contexts;
  }

  /** Whether any lifecycle rule runs on `event`. */
  hasLifecycle(event: "prompt_submit" | "stop"): boolean {
    return this.lifecycleRules.some((rule) => rule.event === event);
  }
}
