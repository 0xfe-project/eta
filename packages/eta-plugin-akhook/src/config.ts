import type {
  ArgvItem,
  CheckSpec,
  CommandSpec,
  Config,
  ConfigInput,
  LoadedConfig,
  RuleSpec,
} from "./types";
/**
 * The akhook configuration file, kept exactly as akhook defines it (`docs/design.md`), plus one
 * new rule kind: `on: stream`.
 *
 * Parsing is strict on purpose: an unknown field is an error, the way akhook's
 * `deny_unknown_fields` makes it, so a typo in a rule never becomes a rule that silently does
 * nothing. Merging follows akhook too: preset, user, project, then each additional config in
 * order. The rules of an additional config cannot be disabled or replaced by the layers before
 * it, only by itself or a later additional config.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { ompRules } from "./preset";
import { ConfigError, RULE_EVENTS } from "./types";

export { ConfigError } from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, reason: string): never {
  throw new ConfigError(`${where}: ${reason}`);
}

/** Reject keys outside `allowed`, as akhook's `deny_unknown_fields` does. */
function only(where: string, value: Plain, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, `unknown field \`${key}\``);
  }
}

function strings(where: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    fail(where, "must be a list of strings");
  return value as string[];
}

function oneOrMany(where: string, value: unknown): string[] {
  if (typeof value === "string") return [value];
  return strings(where, value);
}

function command(where: string, value: unknown): CommandSpec {
  if (!isPlain(value)) fail(where, "must be a mapping with argv");
  only(where, value, ["argv", "timeout_ms"]);
  const argv = strings(`${where}.argv`, value.argv);
  const timeout = value.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeout !== "number" || !Number.isInteger(timeout))
    fail(where, "timeout_ms must be an integer");
  return { argv, timeout_ms: timeout };
}

function argvItem(where: string, value: unknown): ArgvItem {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value as string[];
  return fail(where, "must be a word or a list of words");
}

function check(where: string, value: unknown): CheckSpec {
  if (!isPlain(value)) fail(where, "must be a mapping");
  const keys = Object.keys(value);
  if (keys.length !== 1)
    fail(where, "must have exactly one of regex, ast, argv, command");
  if ("regex" in value) {
    if (typeof value.regex !== "string") fail(where, "regex must be a string");
    return { regex: value.regex };
  }
  if ("ast" in value) {
    const ast = value.ast;
    if (!isPlain(ast)) fail(where, "ast must be a mapping");
    only(`${where}.ast`, ast, ["language", "pattern"]);
    if (typeof ast.pattern !== "string")
      fail(where, "ast.pattern must be a string");
    if (ast.language !== undefined && typeof ast.language !== "string")
      fail(where, "ast.language must be a string");
    return {
      ast: {
        pattern: ast.pattern,
        ...(ast.language === undefined ? {} : { language: ast.language }),
      },
    };
  }
  if ("argv" in value) {
    if (!Array.isArray(value.argv)) fail(where, "argv must be a list");
    return {
      argv: value.argv.map((item, index) =>
        argvItem(`${where}.argv[${index}]`, item),
      ),
    };
  }
  if ("command" in value)
    return { command: command(`${where}.command`, value.command) };
  return fail(where, `unknown check \`${keys[0]}\``);
}

const RULE_KEYS = [
  "id",
  "on",
  "paths",
  "actions",
  "tools",
  "checks",
  "message",
  "action",
  "decide",
  "run",
  "scope",
  "interrupt_mode",
  "repeat_mode",
  "repeat_gap",
];

function enumOf<T extends string>(
  where: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    fail(where, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function rule(where: string, value: unknown): RuleSpec {
  if (!isPlain(value)) fail(where, "must be a mapping");
  only(where, value, RULE_KEYS);
  if (typeof value.id !== "string" || value.id.trim() === "")
    fail(where, "id must not be blank");
  const id = value.id;
  const at = `rule ${id}`;
  const spec: RuleSpec = {
    id,
    on: enumOf(`${at}.on`, value.on, RULE_EVENTS),
    paths: strings(`${at}.paths`, value.paths),
    actions: strings(`${at}.actions`, value.actions).map((action) =>
      enumOf(`${at}.actions`, action, ["create", "modify", "delete"] as const),
    ),
    tools: strings(`${at}.tools`, value.tools),
    checks: Array.isArray(value.checks)
      ? value.checks.map((item, index) => check(`${at}.checks[${index}]`, item))
      : value.checks === undefined
        ? []
        : fail(at, "checks must be a list"),
    scope: oneOrMany(`${at}.scope`, value.scope),
  };
  if (value.message !== undefined) {
    if (typeof value.message !== "string" || value.message.trim() === "")
      fail(at, "message must not be blank");
    spec.message = value.message;
  }
  if (value.action !== undefined)
    spec.action = enumOf(`${at}.action`, value.action, [
      "deny",
      "ask",
    ] as const);
  if (value.decide !== undefined)
    spec.decide = command(`${at}.decide`, value.decide);
  if (value.run !== undefined) spec.run = command(`${at}.run`, value.run);
  if (value.interrupt_mode !== undefined)
    spec.interrupt_mode = enumOf(`${at}.interrupt_mode`, value.interrupt_mode, [
      "always",
      "prose-only",
      "tool-only",
      "never",
    ] as const);
  if (value.repeat_mode !== undefined)
    spec.repeat_mode = enumOf(`${at}.repeat_mode`, value.repeat_mode, [
      "once",
      "after-gap",
    ] as const);
  if (value.repeat_gap !== undefined) {
    if (
      typeof value.repeat_gap !== "number" ||
      !Number.isInteger(value.repeat_gap) ||
      value.repeat_gap < 0
    )
      fail(at, "repeat_gap must be a non-negative integer");
    spec.repeat_gap = value.repeat_gap;
  }
  return spec;
}

/** Parse and validate one configuration file's text. */
export function parseConfig(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `parsing ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const where = source;
  // An empty file is a file with nothing to say, which still needs its version.
  if (!isPlain(raw)) fail(where, "must be a mapping with `version: 1`");
  only(where, raw, [
    "version",
    "presets",
    "disabled_rules",
    "rules",
    "ask_instruction",
    "shell_tools",
  ]);
  if (raw.version !== 1)
    fail(where, `unsupported config version ${String(raw.version)}`);
  const shellTools: Record<string, string> = {};
  if (raw.shell_tools !== undefined) {
    if (!isPlain(raw.shell_tools)) fail(where, "shell_tools must be a mapping");
    for (const [name, field] of Object.entries(raw.shell_tools)) {
      if (typeof field !== "string")
        fail(where, `shell_tools.${name} must be a string`);
      shellTools[name] = field;
    }
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules))
    fail(where, "rules must be a list");
  if (
    raw.ask_instruction !== undefined &&
    typeof raw.ask_instruction !== "string"
  )
    fail(where, "ask_instruction must be a string");
  return {
    version: 1,
    presets: strings(`${where}.presets`, raw.presets),
    disabled_rules: strings(`${where}.disabled_rules`, raw.disabled_rules),
    rules: ((raw.rules ?? []) as unknown[]).map((item, index) =>
      rule(`${where}.rules[${index}]`, item),
    ),
    shell_tools: shellTools,
    ...(raw.ask_instruction === undefined
      ? {}
      : { ask_instruction: raw.ask_instruction as string }),
  };
}

export interface LoadOptions {
  cwd: string;
  /** The user-level file; defaults to the platform's config directory under `akhook/akhook.yml`. */
  userConfigPath?: string | undefined;
  /** Layers merged after the user and project ones, in order. */
  additional?: readonly ConfigInput[];
  /** Whether to look for a project `.akhook.yml` from `cwd` upward. Default true. */
  project?: boolean;
}

/** akhook's user-level configuration path: `<config dir>/akhook/akhook.yml`. */
export function defaultUserConfigPath(): string {
  const home = homedir();
  if (platform() === "darwin")
    return join(home, "Library", "Application Support", "akhook", "akhook.yml");
  const base = process.env.XDG_CONFIG_HOME;
  return join(
    base !== undefined && base !== "" ? base : join(home, ".config"),
    "akhook",
    "akhook.yml",
  );
}

/** The paths named by `AKHOOK_ADDITIONAL_CONFIG_PATH` (a platform path list), in order. */
export function additionalConfigPathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConfigInput[] {
  const value = env.AKHOOK_ADDITIONAL_CONFIG_PATH;
  if (value === undefined || value === "") return [];
  const separator = platform() === "win32" ? ";" : ":";
  return value
    .split(separator)
    .filter((path) => path !== "")
    .map((path) => ({ path }));
}

/** The nearest `.akhook.yml` from `cwd` upward, if any. */
export function projectConfigPath(cwd: string): string | undefined {
  let dir = cwd;
  const { root } = parsePath(dir);
  for (;;) {
    const candidate = join(dir, ".akhook.yml");
    if (existsSync(candidate)) {
      if (!statSync(candidate).isFile())
        throw new ConfigError(`${candidate} is not a file`);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) return undefined;
    dir = parent;
  }
}

function read(path: string): { text: string; source: string } | undefined {
  if (!existsSync(path)) return undefined;
  return { text: readFileSync(path, "utf8"), source: path };
}

function presetRules(names: readonly string[]): RuleSpec[] {
  const rules: RuleSpec[] = [];
  for (const name of names) {
    if (name !== "omp") throw new ConfigError(`unknown preset ${name}`);
    rules.push(...ompRules());
  }
  return rules;
}

/**
 * Merge preset, user and project rules (`disabled_rules` applies to all of them), then each
 * additional config in order. akhook's loader, rule for rule.
 */
export function loadConfig(options: LoadOptions): LoadedConfig {
  const files: string[] = [];
  const userPath = options.userConfigPath ?? defaultUserConfigPath();
  const projectPath =
    options.project === false ? undefined : projectConfigPath(options.cwd);
  const root = projectPath === undefined ? options.cwd : dirname(projectPath);

  const layer = (path: string): Config | undefined => {
    files.push(path);
    const found = read(path);
    return found === undefined ? undefined : parseConfig(found.text, path);
  };
  const user = layer(userPath);
  const project = projectPath === undefined ? undefined : layer(projectPath);
  // The project file is looked for on every load, so its absence is remembered too.
  if (options.project !== false) files.push(join(options.cwd, ".akhook.yml"));
  const additional = (options.additional ?? []).map((input) => {
    if ("text" in input) return parseConfig(input.text, input.name);
    files.push(input.path);
    const found = read(input.path);
    if (found === undefined)
      throw new ConfigError(`additional config ${input.path} not found`);
    return parseConfig(found.text, input.path);
  });

  const layers = [user, project, ...additional].filter(
    (config): config is Config => config !== undefined,
  );
  const presets: string[] = [];
  const shellTools: Record<string, string> = {};
  let askInstruction: string | undefined;
  for (const config of layers) {
    Object.assign(shellTools, config.shell_tools);
    for (const name of config.presets)
      if (!presets.includes(name)) presets.push(name);
    if (config.ask_instruction !== undefined)
      askInstruction = config.ask_instruction;
  }

  const byId = new Map<string, RuleSpec>();
  for (const spec of presetRules(presets)) byId.set(spec.id, spec);
  const disabled: string[] = [];
  for (const config of [user, project]) {
    if (config === undefined) continue;
    disabled.push(...config.disabled_rules);
    for (const spec of config.rules) byId.set(spec.id, spec);
  }
  for (const id of disabled) byId.delete(id);
  for (const config of additional) {
    for (const id of config.disabled_rules) byId.delete(id);
    for (const spec of config.rules) byId.set(spec.id, spec);
  }
  return {
    root,
    rules: [...byId.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    shellTools,
    files,
    ...(askInstruction === undefined ? {} : { askInstruction }),
  };
}
