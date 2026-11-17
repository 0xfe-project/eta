/**
 * The model seam (REFACTOR.md §2.2).
 *
 * No new interface is invented around provider internals: the kernel needs
 * three methods off pi-ai's `Models`, and that is what it declares. A real
 * `Models` instance satisfies it as-is; tests pass a scripted fake.
 */
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ThinkingLevel as ProviderThinkingLevel,
} from "@earendil-works/pi-ai";
import type { KernelConfig } from "../types/config";
import type { ThinkingLevel } from "../types/messages";

/**
 * What the kernel asks of the model layer: resolve the configured model, then
 * stream (or complete) a request. Auth, retries at the transport level, and
 * provider catalogs stay behind this edge.
 */
export type KernelModels = Pick<
  Models,
  "getModel" | "streamSimple" | "completeSimple"
>;

/**
 * Every thinking level, as a runtime list. The union is compile-time only, and a
 * configuration coming off the wire has to be checked against something.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly ThinkingLevel[];

/**
 * The levels outside the provider layer's own vocabulary: an external runtime may declare them
 * (`ultra`), pi-ai has no word for them. A model offers one only when its map names it.
 */
const BEYOND_PROVIDERS: ReadonlySet<ThinkingLevel> = new Set(["ultra"]);

/**
 * The levels a model can actually be asked for.
 *
 * A camera model on a non-reasoning provider: `off`. Otherwise the provider's own map
 * decides — a level marked `null` is one the model does not take, and a level the map
 * does not mention is left to the provider's default, which is why an unmentioned level
 * counts as supported rather than as absent — except a level beyond the provider layer's
 * vocabulary (`ultra`): no provider map can mention it by default, so only a model whose map names
 * it explicitly takes it.
 */
export function thinkingLevelsFor(
  model: Model<Api> | undefined,
): ThinkingLevel[] {
  if (model === undefined) return [...THINKING_LEVELS];
  if (model.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((level) => {
    const mapped = (map as Record<string, string | null | undefined>)[level];
    return BEYOND_PROVIDERS.has(level)
      ? model.thinkingLevelMap !== undefined && typeof mapped === "string"
      : mapped !== null;
  });
}

/**
 * The reasoning a provider request carries at a thinking level: none at `off` (the kernel's
 * spelling for "no reasoning field at all"), and none at a level the provider layer has no word
 * for, so the model runs on its default rather than receiving a value it does not know.
 */
export function providerReasoning(
  level: ThinkingLevel,
): ProviderThinkingLevel | undefined {
  if (level === "off" || BEYOND_PROVIDERS.has(level)) return undefined;
  return level as ProviderThinkingLevel;
}

/** The reasoning option of a provider request at a thinking level: absent when none is sent. */
export function reasoningOption(level: ThinkingLevel): {
  reasoning?: ProviderThinkingLevel;
} {
  const reasoning = providerReasoning(level);
  return reasoning === undefined ? {} : { reasoning };
}

/**
 * What one run asked for and what it actually sent, written on the run's assistant messages.
 * `asked` is the session's chosen level, `null` when none was chosen (the model's default);
 * `sent` is the value handed to the model or runtime, `null` when nothing was (its default).
 */
export interface ThinkingRecord {
  asked: ThinkingLevel | null;
  sent: string | null;
}

/** An assistant message, with the record of the run it came from. */
export type RecordedAssistantMessage = AssistantMessage & {
  effort?: ThinkingRecord;
};

/** Write a run's thinking record on one of its assistant messages. */
export function recordThinking(
  message: AssistantMessage,
  record: ThinkingRecord,
): void {
  (message as RecordedAssistantMessage).effort = record;
}

/**
 * The level a session was asked to think at. A session that recorded no choice and sits on the
 * kernel's `off` was never given one: it follows the model.
 */
export function askedThinking(
  config: Pick<KernelConfig, "thinkingLevel" | "thinkingAsked">,
): ThinkingLevel | null {
  if (config.thinkingAsked !== undefined) return config.thinkingAsked;
  return config.thinkingLevel === "off" ? null : config.thinkingLevel;
}

/** The record of a run on the kernel's own loop: what the provider request carries. */
export function kernelThinking(
  config: Pick<KernelConfig, "thinkingLevel" | "thinkingAsked">,
): ThinkingRecord {
  const asked = askedThinking(config);
  const level = config.thinkingLevel;
  // `off` is sent as such only when it was the choice; an `off` the session fell back to (or
  // started on) is the model's default.
  if (level === "off") return { asked, sent: asked === "off" ? "off" : null };
  return { asked, sent: providerReasoning(level) ?? null };
}
