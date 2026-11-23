// The rows of `/model`'s two lists. The offered thinking levels are the model's own
// (`agentThinking` in @eta/client-contracts), the rule every agent picker follows.

import type {
  AgentRuntimeInfo,
  ModelThinking,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { Translate } from "../../i18n/messages";
import type { Model } from "../kit/models";
import type { PickItem } from "../kit/pick-list";
import type { modelMessages } from "./messages";
import {
  agentThinking,
  FALLBACK_LEVELS,
  levelSupport,
  runtimeModelThinking,
} from "@eta/client-contracts";

type ModelKey = keyof typeof modelMessages.en;

/** A model an agent can be set to: `provider:modelId`, and how it is shown. */
export interface ModelChoice {
  id: string;
  provider: string;
  providerName: string;
  name: string;
  /** Listed only because the agent has it now. */
  unusable?: boolean;
  /** The thinking levels it declares. */
  thinking: ModelThinking;
}

const RUNTIME_DEFAULT_KEY = "runtime-default";
const MODEL = "model:";
const GROUP = "group:";

export function choicesOfModels(models: readonly Model[]): ModelChoice[] {
  return models.map(({ id, provider, providerName, name, thinking }) => ({
    id,
    provider,
    providerName,
    name,
    thinking,
  }));
}

/** An external runtime's models, as an agent on it names them (`runtime:modelId`). */
export function choicesOfRuntime(info: AgentRuntimeInfo): ModelChoice[] {
  return info.models.map((model) => ({
    id: `${info.id}:${model.id}`,
    provider: info.id,
    providerName: info.label,
    name: model.name,
    thinking: runtimeModelThinking(model),
  }));
}

/**
 * The levels of the model a row of `modelRows` stands for: its choice's, the runtime's default
 * model's for `null`, else not known.
 */
export function thinkingOfChoice(
  runtime: AgentRuntimeInfo["id"] | "eta",
  model: string | null,
  choices: readonly ModelChoice[],
  info: AgentRuntimeInfo | undefined,
): ModelThinking {
  const choice = choices.find((entry) => entry.id === model);
  if (choice !== undefined) return choice.thinking;
  return agentThinking(runtime, model, {
    runtimes: info === undefined ? undefined : [info],
  });
}

/** `provider / name`: how a model is named when it is said back to the user. */
export function choiceText(choice: ModelChoice): string {
  return `${choice.providerName} / ${choice.name}`;
}

/** The agent's model as a choice, when the list does not have it. */
function missingCurrent(current: string): ModelChoice {
  const split = current.indexOf(":");
  const provider = split < 0 ? current : current.slice(0, split);
  return {
    id: current,
    provider,
    providerName: provider,
    name: split < 0 ? current : current.slice(split + 1),
    unusable: true,
    thinking: { basis: "unknown", levels: FALLBACK_LEVELS },
  };
}

/**
 * The models under a row naming their provider, in the order the providers first appear. An
 * external runtime has a default of its own, offered first as "no model"; eta's own loop has none,
 * so an agent on it always names a model. The agent's model is tagged current, and listed even
 * when it is not among `choices`.
 */
export function modelRows(
  choices: readonly ModelChoice[],
  current: string | null,
  t: Translate<ModelKey>,
  runtimeDefault: boolean,
): { items: PickItem[]; currentKey: string } {
  const all =
    current === null || choices.some((choice) => choice.id === current)
      ? [...choices]
      : [...choices, missingCurrent(current)];
  const groups = new Map<string, ModelChoice[]>();
  for (const choice of all) {
    const group = groups.get(choice.provider) ?? [];
    group.push(choice);
    groups.set(choice.provider, group);
  }
  const tag = (isCurrent: boolean) => (isCurrent ? { tag: t("current") } : {});
  const items: PickItem[] = runtimeDefault
    ? [
        {
          key: RUNTIME_DEFAULT_KEY,
          label: t("runtimeDefault"),
          ...tag(current === null),
        },
      ]
    : [];
  for (const [provider, group] of groups) {
    items.push({
      key: `${GROUP}${provider}`,
      label: group[0]?.providerName ?? provider,
      disabled: true,
    });
    for (const choice of group)
      items.push({
        key: `${MODEL}${choice.id}`,
        label: `  ${choice.name}`,
        ...(choice.unusable === true ? { hint: t("unavailable") } : {}),
        ...tag(choice.id === current),
      });
  }
  const first = items.find((item) => item.disabled !== true)?.key ?? "";
  return {
    items,
    currentKey:
      current !== null
        ? `${MODEL}${current}`
        : runtimeDefault
          ? RUNTIME_DEFAULT_KEY
          : first,
  };
}

/** The model a row of `modelRows` stands for: null for the runtime's own default. */
export function modelOfRow(key: string): string | null {
  return key === RUNTIME_DEFAULT_KEY ? null : key.slice(MODEL.length);
}

/** The key of the row of `modelRows` for a model. */
export function rowOfModel(model: string | null): string {
  return model === null ? RUNTIME_DEFAULT_KEY : `${MODEL}${model}`;
}

const OWN_KEY = "own";
const LEVEL = "level:";

function levelName(level: ThinkingLevel, t: Translate<ModelKey>): string {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
      return t(level);
    default:
      return level;
  }
}

/** How a level is said back to the user. */
export function levelText(
  level: ThinkingLevel | null,
  t: Translate<ModelKey>,
): string {
  return level === null ? t("modelOwnLevel") : levelName(level, t);
}

/**
 * The model's own level, then the ones the model declares (`agentThinking`); the agent's level is
 * tagged current. The agent's level is listed after them when it is not one of them: shown but not
 * pickable when the model is known not to take it, and pickable when its levels are not known.
 */
export function levelRows(
  current: ThinkingLevel | null,
  thinking: ModelThinking,
  t: Translate<ModelKey>,
): { items: PickItem[]; currentKey: string } {
  const offered = thinking.levels;
  const extra =
    current === null || offered.includes(current) ? undefined : current;
  const refused =
    extra !== undefined && levelSupport(thinking, extra) === "unsupported";
  const tag = (isCurrent: boolean) => (isCurrent ? { tag: t("current") } : {});
  return {
    items: [
      { key: OWN_KEY, label: t("modelOwn"), ...tag(current === null) },
      ...offered.map((level) => ({
        key: `${LEVEL}${level}`,
        label: levelName(level, t),
        ...tag(level === current),
      })),
      ...(extra === undefined
        ? []
        : [
            {
              key: `${LEVEL}${extra}`,
              label: levelName(extra, t),
              ...tag(true),
              ...(refused ? { hint: t("levelNotTaken"), disabled: true } : {}),
            },
          ]),
    ],
    currentKey: current === null || refused ? OWN_KEY : `${LEVEL}${current}`,
  };
}

/** Why the list offers what it does, where that is not the model's own declaration. */
export function levelNote(
  thinking: ModelThinking,
  t: Translate<ModelKey>,
): string | undefined {
  switch (thinking.basis) {
    case "unknown":
      return t("levelsUnknown");
    case "undeclared":
      return t("levelsUndeclared");
    case "none":
      return t("levelsNone");
    default:
      return undefined;
  }
}

/** The level a row of `levelRows` stands for: null for the model's own. */
export function levelOfRow(key: string): ThinkingLevel | null {
  return key === OWN_KEY ? null : (key.slice(LEVEL.length) as ThinkingLevel);
}
