// The rows of `/model`'s two lists. The offered thinking levels are apps/web/src/lib/thinking.ts's.

import type { AgentRuntimeInfo, ThinkingLevel } from "@eta/client-contracts";
import type { Translate } from "../../i18n/messages";
import type { Model } from "../kit/models";
import type { PickItem } from "../kit/pick-list";
import type { modelMessages } from "./messages";

type ModelKey = keyof typeof modelMessages.en;

/** A model an agent can be set to: `provider:modelId`, and how it is shown. */
export interface ModelChoice {
  id: string;
  provider: string;
  providerName: string;
  name: string;
  /** Listed only because the agent has it now. */
  unusable?: boolean;
}

const SETTINGS_KEY = "settings";
const MODEL = "model:";
const GROUP = "group:";

export function choicesOfModels(models: readonly Model[]): ModelChoice[] {
  return models.map(({ id, provider, providerName, name }) => ({
    id,
    provider,
    providerName,
    name,
  }));
}

/** An external runtime's models, as an agent on it names them (`runtime:modelId`). */
export function choicesOfRuntime(info: AgentRuntimeInfo): ModelChoice[] {
  return info.models.map((model) => ({
    id: `${info.id}:${model.id}`,
    provider: info.id,
    providerName: info.label,
    name: model.name,
  }));
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
  };
}

/**
 * Following the settings first, then the models under a row naming their provider, in the order
 * the providers first appear. The agent's model is tagged current, and listed even when it is not
 * among `choices`.
 */
export function modelRows(
  choices: readonly ModelChoice[],
  current: string | null,
  t: Translate<ModelKey>,
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
  const items: PickItem[] = [
    { key: SETTINGS_KEY, label: t("followSettings"), ...tag(current === null) },
  ];
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
  return {
    items,
    currentKey: current === null ? SETTINGS_KEY : `${MODEL}${current}`,
  };
}

/** The model a row of `modelRows` stands for: null for following the settings. */
export function modelOfRow(key: string): string | null {
  return key === SETTINGS_KEY ? null : key.slice(MODEL.length);
}

/** The key of the row of `modelRows` for a model. */
export function rowOfModel(model: string | null): string {
  return model === null ? SETTINGS_KEY : `${MODEL}${model}`;
}

/** What the thinking list offers: the model's own level, then these. */
const OFFERED: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];
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
 * The model's own level, then the offered ones; the agent's level is tagged current, and listed
 * after them when it is not one of them.
 */
export function levelRows(
  current: ThinkingLevel | null,
  t: Translate<ModelKey>,
): { items: PickItem[]; currentKey: string } {
  const levels =
    current === null || OFFERED.includes(current)
      ? OFFERED
      : [...OFFERED, current];
  const tag = (isCurrent: boolean) => (isCurrent ? { tag: t("current") } : {});
  return {
    items: [
      { key: OWN_KEY, label: t("modelOwn"), ...tag(current === null) },
      ...levels.map((level) => ({
        key: `${LEVEL}${level}`,
        label: levelName(level, t),
        ...tag(level === current),
      })),
    ],
    currentKey: current === null ? OWN_KEY : `${LEVEL}${current}`,
  };
}

/** The level a row of `levelRows` stands for: null for the model's own. */
export function levelOfRow(key: string): ThinkingLevel | null {
  return key === OWN_KEY ? null : (key.slice(LEVEL.length) as ThinkingLevel);
}
