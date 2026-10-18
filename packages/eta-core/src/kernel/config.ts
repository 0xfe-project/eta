/**
 * ConfigService — the session's configuration, read live by the runner
 * (ported from eta-agent's lane config + process Config).
 *
 * The runner never caches it: a model or thinking level changed mid-run must
 * reach the next request, which is the whole reason btw side requests can
 * inherit whatever the user just chose. Every accepted change reports a
 * `state:config-update`.
 */
import { type Context, Service } from "cordis";
import {
  CONFIG_PROPERTIES,
  type CompactionSettings,
  type ConfigProperty,
  defaultKernelConfig,
  type KernelConfig,
} from "../types/config";
import { type Emit, kernelEmit } from "../types/events";
import { type AgentRetryPolicy, DEFAULT_RETRY_POLICY } from "./retry";

/** Duplicate tool names would make a call ambiguous; refuse them at the door. */
export function validateToolNames(tools: readonly { name: string }[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name))
      throw new TypeError(`Duplicate tool name: ${JSON.stringify(tool.name)}`);
    names.add(tool.name);
  }
}

export function validateRetryPolicy(policy: AgentRetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxRetries) ||
    policy.maxRetries < 0 ||
    policy.maxRetries === Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    (policy.maxAgentDelayMs !== undefined &&
      (!Number.isSafeInteger(policy.maxAgentDelayMs) ||
        policy.maxAgentDelayMs < 0))
  ) {
    throw new RangeError(
      "Retry policy values must be finite non-negative safe integers",
    );
  }
}

export function validateCompactionSettings(settings: CompactionSettings): void {
  if (
    !Number.isSafeInteger(settings.reserveTokens) ||
    settings.reserveTokens < 0 ||
    !Number.isSafeInteger(settings.keepRecentTokens) ||
    settings.keepRecentTokens < 0 ||
    (settings.maxContextTokens !== undefined &&
      (!Number.isSafeInteger(settings.maxContextTokens) ||
        settings.maxContextTokens < 0))
  ) {
    throw new RangeError(
      "Compaction token counts must be finite non-negative safe integers",
    );
  }
}

export function validateKernelConfig(config: KernelConfig): void {
  validateToolNames(config.activeToolNames.map((name) => ({ name })));
  validateRetryPolicy(config.retryPolicy);
  validateCompactionSettings(config.compaction);
  // The model identity is not validated here: a session may exist before a
  // model is chosen, and an unresolvable one is reported as `model_unavailable`
  // when a run asks for it (eta-agent's behaviour).
}

export class ConfigService extends Service {
  static readonly provide = "config";

  private config: KernelConfig;
  private readonly emit: Emit;

  constructor(ctx: Context, initial: KernelConfig = defaultKernelConfig()) {
    super(ctx, "config");
    validateKernelConfig(initial);
    this.config = initial;
    this.emit = kernelEmit(ctx);
  }

  /** The current configuration. Treat it as read-only; change it through `update`. */
  get(): Readonly<KernelConfig> {
    return this.config;
  }

  /** Read one property; the runner reads every turn instead of caching. */
  read<K extends ConfigProperty>(property: K): KernelConfig[K] {
    return this.config[property];
  }

  /**
   * Apply a patch, validating first: an invalid value throws and leaves the
   * configuration untouched. Each changed property reports its own update.
   */
  update(patch: Partial<KernelConfig>): void {
    const next: KernelConfig = { ...this.config, ...patch };
    validateKernelConfig(next);
    const previous = this.config;
    // The new configuration is in place before anyone hears about it: a
    // subscriber that reacts by reading the config must see what it was told,
    // not the state it just replaced.
    this.config = next;
    for (const property of CONFIG_PROPERTIES) {
      if (!(property in patch)) continue;
      const before = previous[property];
      const value = next[property];
      if (Object.is(before, value)) continue;
      this.emit("state:config-update", { property, value, previous: before });
    }
  }

  /** Convenience for the most common change. */
  setModel(provider: string, modelId: string): void {
    this.update({ model: { provider, modelId } });
  }

  /** Restore the defaults (tests, session reset). */
  reset(overrides: Partial<KernelConfig> = {}): void {
    this.update(
      defaultKernelConfig({
        ...overrides,
        model: overrides.model ?? this.config.model,
      }),
    );
  }
}

/** The retry policy defaults a fresh config carries. */
export const RETRY_DEFAULTS = DEFAULT_RETRY_POLICY;
