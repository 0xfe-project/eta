/**
 * Which thinking levels an agent can be set to: one rule for every picker (desktop client, phone,
 * TUI) and for the host when it saves an agent.
 *
 * The levels come from what the model or runtime declares, never from a list of our own:
 *
 * - an eta model (a configured provider's, or the LLM gateway's) declares `reasoning`,
 *   `reasoningEfforts` and `thinkingMode` in `config.json`;
 * - an external runtime's model declares `efforts` in the machine's runtime list, in the
 *   runtime's own spelling (`none` is its off switch).
 *
 * What is not known (no declaration, a machine that is offline, a list that has not come back) is
 * not "none": the picker offers the five levels every model has been offered so far, and the level
 * is passed on as it is.
 */
import type { ThinkingLevel } from "./data";
import type { LlmModel } from "./llm";
import type {
  AgentRuntime,
  AgentRuntimeInfo,
  AgentRuntimeModel,
} from "./product";
import type { ModelCapabilities } from "./types";

/** Every thinking level an agent can be set to, lowest first. */
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
 * What a picker offers for a model whose levels are not known: the five levels every model has
 * been offered so far, and no more — a level beyond them is one most models refuse.
 */
export const FALLBACK_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ThinkingLevel[];

/** Whether a string is a thinking level. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Why a model offers the levels it does.
 *
 * - `declared`: it lists them (an eta model's `reasoningEfforts`, a runtime model's `efforts`);
 *   `reasoning: false` is a declaration too, of `off` alone.
 * - `none`: an external runtime has no effort setting for it: there is nothing to pick but the
 *   model's default.
 * - `undeclared`: an eta model that says nothing about thinking. eta sends it no reasoning field,
 *   so `off` is all a level can be.
 * - `unknown`: the levels could not be learned; the fallback five are offered and passed on as
 *   they are.
 */
export type ThinkingBasis = "declared" | "none" | "undeclared" | "unknown";

export interface ModelThinking {
  basis: ThinkingBasis;
  /** What a picker offers besides the model's default, lowest first. */
  levels: readonly ThinkingLevel[];
}

/** The thinking facts of an eta model, as the config and the gateway catalog state them. */
export interface EtaModelThinking {
  reasoning?: ModelCapabilities["reasoning"] | undefined;
  reasoningEfforts?: ModelCapabilities["reasoningEfforts"] | undefined;
  thinkingMode?: ModelCapabilities["thinkingMode"] | undefined;
  overrides?: ModelCapabilities | undefined;
}

const UNKNOWN: ModelThinking = { basis: "unknown", levels: FALLBACK_LEVELS };

/**
 * An eta model's levels. It mirrors what the session's model layer does with the same facts
 * (`modelThinkingLevels` and `thinkingLevelMap` in `@eta/server`): a level offered here is one a
 * run sends.
 */
export function etaModelThinking(
  input: EtaModelThinking | undefined,
): ModelThinking {
  if (input === undefined) return UNKNOWN;
  const model = { ...input, ...input.overrides };
  if (model.thinkingMode === "no" || model.reasoning === false)
    return { basis: "declared", levels: ["off"] };
  if (model.reasoning !== true) return { basis: "undeclared", levels: ["off"] };
  const efforts: readonly string[] = model.reasoningEfforts ?? [];
  if (efforts.length === 0) {
    // It thinks, at levels it does not name: the fallback five, `off` only where it can stop.
    return model.thinkingMode === "only"
      ? { basis: "unknown", levels: FALLBACK_LEVELS.slice(1) }
      : UNKNOWN;
  }
  return {
    basis: "declared",
    levels: THINKING_LEVELS.filter((level) =>
      level === "off"
        ? model.thinkingMode === "both"
        : level !== "ultra" && efforts.includes(level),
    ),
  };
}

/**
 * An external runtime's model's levels: the ones it lists, `off` where it lists `none` (or `off`),
 * which is what the runtime is sent for it (`effortFor` in the runtime packages). A model
 * the list does not hold, or one whose levels the runtime could not say, is unknown.
 */
export function runtimeModelThinking(
  model: Pick<AgentRuntimeModel, "efforts" | "effortsUnknown"> | undefined,
): ModelThinking {
  if (model === undefined || model.effortsUnknown === true) return UNKNOWN;
  if (model.efforts.length === 0) return { basis: "none", levels: [] };
  const levels = THINKING_LEVELS.filter((level) =>
    level === "off"
      ? model.efforts.includes("none") || model.efforts.includes("off")
      : model.efforts.includes(level),
  );
  // A runtime whose words are none of eta's: its levels cannot be named here, so nothing is known.
  return levels.length === 0 ? UNKNOWN : { basis: "declared", levels };
}

/** What the levels of an agent's model are looked up in. Absent parts are not known. */
export interface ThinkingCatalog {
  /** The configured providers (`providers.config`), their models as the client sees them. */
  providers?:
    | readonly {
        id: string;
        models: readonly (EtaModelThinking & { id: string })[];
      }[]
    | undefined;
  /** The LLM gateway's models (`llm.models`). */
  llm?: readonly (Pick<LlmModel, "id"> & EtaModelThinking)[] | undefined;
  /** The external runtimes of the agent's machine: undefined or null while not known. */
  runtimes?:
    | readonly Pick<AgentRuntimeInfo, "id" | "status" | "models">[]
    | null
    | undefined;
}

/** The provider id the gateway's models go under (`LLM_PROVIDER_ID`, kept here to stay type-only). */
const GATEWAY = "llm";

/**
 * The levels an agent on this runtime and model can be set to.
 *
 * `model` is as an agent stores it: `provider:id` on eta, `runtime:id` (or null for the runtime's
 * default model) on an external runtime.
 */
export function agentThinking(
  runtime: AgentRuntime,
  model: string | null | undefined,
  catalog: ThinkingCatalog,
): ModelThinking {
  const value = model?.trim() ?? "";
  if (runtime === "eta") {
    const split = value.indexOf(":");
    if (split <= 0) return UNKNOWN;
    const provider = value.slice(0, split);
    const id = value.slice(split + 1);
    if (provider === GATEWAY) {
      const found = catalog.llm?.find((entry) => entry.id === id);
      return found === undefined ? UNKNOWN : etaModelThinking(found);
    }
    return etaModelThinking(
      catalog.providers
        ?.find((entry) => entry.id === provider)
        ?.models.find((entry) => entry.id === id),
    );
  }
  const info = catalog.runtimes?.find((entry) => entry.id === runtime);
  if (info === undefined || info.status !== "available") return UNKNOWN;
  const id = value.startsWith(`${runtime}:`)
    ? value.slice(runtime.length + 1)
    : value;
  return runtimeModelThinking(
    id === ""
      ? info.models.find((entry) => entry.default)
      : info.models.find((entry) => entry.id === id),
  );
}

/**
 * Whether a model takes a level: `supported`, `unsupported` (its levels are known and this is not
 * one), or `unknown` (they are not; the level is passed on as it is and the model decides).
 */
export type LevelSupport = "supported" | "unsupported" | "unknown";

export function levelSupport(
  thinking: ModelThinking,
  level: ThinkingLevel,
): LevelSupport {
  if (thinking.levels.includes(level)) return "supported";
  return thinking.basis === "unknown" ? "unknown" : "unsupported";
}

/**
 * The level to keep when the model changes: the old one when the new model takes it (or its
 * levels are not known), else the model's default (`null`).
 */
export function keptLevel(
  thinking: ModelThinking,
  level: ThinkingLevel | null,
): ThinkingLevel | null {
  if (level === null) return null;
  return levelSupport(thinking, level) === "unsupported" ? null : level;
}
