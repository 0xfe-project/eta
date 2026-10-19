/**
 * The akhook plugin: declarative rules for eta sessions.
 *
 * The configuration is akhook's `.akhook.yml` (presets, user, project, host-provided additional
 * layers, merged as akhook merges them). Its rules run in three places:
 *
 * - tool-call rules (`file_change`, `shell_exec`, `tool_call`) as the session's `ToolMiddleware`:
 *   `deny`, `ask` (through the session's ask channel, so it is a card in the inbox) or `decide`;
 * - lifecycle rules (`prompt_submit`, `stop`) around a run;
 * - `stream` rules, the new kind: they watch the generation and can interrupt it and make the
 *   model generate again (omp's time-traveling stream rules).
 */
export {
  additionalConfigPathsFromEnv,
  ConfigError,
  defaultUserConfigPath,
  loadConfig,
  parseConfig,
  projectConfigPath,
} from "./config";
export { akhookMiddleware, appendToResult } from "./middleware";
export type { AkhookMiddlewareOptions } from "./middleware";
export { ompRules } from "./preset";
export { compileRegex, parseScope, RuleSet } from "./rules";
export type { Candidate, Decision, RuleHit, StreamRule } from "./rules";
export {
  AKHOOK_STATE,
  AkhookSession,
  journalTriggerStore,
  lifecycleHooks,
} from "./session";
export type {
  AkhookSessionOptions,
  LifecycleHooksOptions,
  LifecycleRun,
} from "./session";
export { argvMatches, simpleCommands } from "./shell";
export { RuleSource } from "./source";
export { StreamRules } from "./stream";
export type { StreamState, TriggerStore } from "./stream";
export type {
  Config,
  ConfigInput,
  InterruptMode,
  LoadedConfig,
  RepeatMode,
  RuleSpec,
} from "./types";
