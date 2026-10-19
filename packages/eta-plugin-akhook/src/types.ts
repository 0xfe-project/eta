/** The shapes of an akhook configuration, shared by the parser, the preset and the engine. */

export const RULE_EVENTS = [
  "file_change",
  "shell_exec",
  "tool_call",
  "prompt_submit",
  "stop",
  "stream",
] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

export type FileAction = "create" | "modify" | "delete";
export type RuleAction = "deny" | "ask";
export type InterruptMode = "always" | "prose-only" | "tool-only" | "never";
export type RepeatMode = "once" | "after-gap";

export interface CommandSpec {
  argv: string[];
  timeout_ms: number;
}

/** One position of an `argv` check: a word, or any of several words. */
export type ArgvItem = string | string[];

export type CheckSpec =
  | { regex: string }
  | { ast: { language?: string; pattern: string } }
  | { argv: ArgvItem[] }
  | { command: CommandSpec };

export interface RuleSpec {
  id: string;
  on: RuleEvent;
  paths: string[];
  actions: FileAction[];
  tools: string[];
  checks: CheckSpec[];
  message?: string;
  action?: RuleAction;
  decide?: CommandSpec;
  /** What a lifecycle rule (`prompt_submit`, `stop`) runs. */
  run?: CommandSpec;
  /** `stream` rules: the output surfaces watched (omp's `scope`). */
  scope: string[];
  interrupt_mode?: InterruptMode;
  repeat_mode?: RepeatMode;
  repeat_gap?: number;
}

export interface Config {
  version: 1;
  presets: string[];
  disabled_rules: string[];
  rules: RuleSpec[];
  ask_instruction?: string;
  /** Tools that run shell commands, by name, with the argument that holds the command. */
  shell_tools: Record<string, string>;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** One configuration layer handed to the loader: a file to read, or text the host already holds. */
export type ConfigInput = { path: string } | { name: string; text: string };

export interface LoadedConfig {
  /** The project root: where `.akhook.yml` was found, else the working directory. */
  root: string;
  rules: RuleSpec[];
  /** Kept for compatibility with akhook files; eta asks through its own channel. */
  askInstruction?: string;
  shellTools: Record<string, string>;
  /** Every file that was read, to know when the configuration has to be read again. */
  files: string[];
}
