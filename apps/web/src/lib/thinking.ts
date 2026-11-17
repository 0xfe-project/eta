import type { AssistantMessage, ThinkingLevel } from "@eta/client-contracts";

/** Every thinking level an agent can be set to, lowest first. */
const THINKING_LEVELS = [
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
 * What a picker offers for a model whose levels are not known (it declares none, its machine is
 * offline, its list has not come back): the five levels every model has been offered so far, and
 * no more — a level beyond them is one most models refuse.
 */
export const FALLBACK_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ThinkingLevel[];

/**
 * What a model says about how it thinks. An eta model's comes from `config.json`
 * (`reasoningEfforts`, `thinkingMode`); an external runtime's from the machine's runtime list
 * (`efforts`, in the runtime's spelling).
 */
export interface ModelThinking {
  efforts?: readonly string[] | undefined;
  /** `both`: it can also be asked not to think, which adds `off`. */
  thinkingMode?: "only" | "both" | "no" | undefined;
}

/**
 * The levels a model declares, lowest first; undefined when it declares none, which is not
 * knowing rather than "none". A word of the runtime's that is not a thinking level is not one an
 * agent can be set to, so it is left out.
 */
export function declaredLevels(
  model: ModelThinking | undefined,
): ThinkingLevel[] | undefined {
  const efforts = model?.efforts ?? [];
  if (efforts.length === 0) return undefined;
  const levels = THINKING_LEVELS.filter(
    (level) =>
      (level === "off" && model?.thinkingMode === "both") ||
      efforts.includes(level),
  );
  return levels.length === 0 ? undefined : levels;
}

/**
 * The levels to offer for a model: the ones it declares, else the fallback five. One rule for
 * the agent pickers and the model settings table.
 */
export function levelsFor(
  model: ModelThinking | undefined,
): readonly ThinkingLevel[] {
  return declaredLevels(model) ?? FALLBACK_LEVELS;
}

/**
 * Whether a model takes a level: `supported`, `unsupported` (its levels are known and this is
 * not one), or `unknown` (they are not known; the level is passed as it is and the runtime
 * decides).
 */
export type LevelSupport = "supported" | "unsupported" | "unknown";

export function levelSupport(
  declared: readonly ThinkingLevel[] | undefined,
  level: string,
): LevelSupport {
  if (declared === undefined) return "unknown";
  return (declared as readonly string[]).includes(level)
    ? "supported"
    : "unsupported";
}

/**
 * What one run asked for and what it actually handed the model or runtime, as the run wrote it
 * (`null`: nothing — the model's default).
 */
export type ThinkingRecord = NonNullable<AssistantMessage["effort"]>;

/** Whether the run sent something else than it was asked for: the case worth a warning. */
export const effortDiffers = (record: ThinkingRecord): boolean =>
  record.asked !== record.sent;
