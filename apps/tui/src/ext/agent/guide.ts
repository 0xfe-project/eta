/**
 * The comment lines at the top of the agent's file, in the interface language: how to apply it,
 * what each key takes, and what the host offers to choose from.
 */
import type { Locale } from "../../config/types";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { translatorFor } from "../../i18n/messages";
import { THINKING_LEVELS } from "./agent-file";
import { agentMessages } from "./messages";

/** How many entries of one list the guide names before it says how many more there are. */
export const GUIDE_LIST_LIMIT = 8;

/** What the host offers for the agent's keys. */
export interface AgentChoices {
  /** eta's usable models, as `provider:modelId`. */
  models: readonly string[];
  /** Each available external runtime's models, as `runtime:modelId`. */
  runtimeModels: readonly { runtime: string; models: readonly string[] }[];
  /** Why the external runtimes could not be asked; undefined when they could. */
  runtimeModelsError: string | undefined;
  machines: readonly { id: string; name: string }[];
  plugins: readonly { name: string; needsConfig: boolean }[];
  personas: readonly { id: string; name: string }[];
  /** Why a list could not be read, by list; such a list is empty and the guide says why. */
  unlisted?: Partial<
    Record<"models" | "machines" | "plugins" | "personas", string>
  >;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]\s*/g, " ");
}

export function agentFileGuide(input: {
  agentName: string;
  choices: AgentChoices;
  locale: Locale;
  /** Where the user's version from before a conflict was kept; named at the top when given. */
  savedEdit?: string;
}): string[] {
  const { choices } = input;
  const t = translatorFor(agentMessages, input.locale);
  const list = (
    entries: readonly string[],
    name?: keyof NonNullable<AgentChoices["unlisted"]>,
  ): string => {
    const failure = name === undefined ? undefined : choices.unlisted?.[name];
    if (failure !== undefined) return t("listFailed", { reason: failure });
    if (entries.length === 0) return t("listNone");
    const shown = entries.slice(0, GUIDE_LIST_LIMIT).join(", ");
    const left = entries.length - GUIDE_LIST_LIMIT;
    return left > 0 ? t("listMore", { list: shown, count: left }) : shown;
  };
  const named = ({ id, name }: { id: string; name: string }) =>
    id === name ? id : t("named", { id, name });

  const runtimeLines =
    choices.runtimeModelsError === undefined
      ? choices.runtimeModels.map(({ runtime, models }) =>
          t("guideRuntimeModels", { runtime, list: list(models) }),
        )
      : [t("guideRuntimesFailed", { reason: choices.runtimeModelsError })];

  const savedLines =
    input.savedEdit === undefined
      ? []
      : [t("guideSavedEdit", { path: input.savedEdit }), ""];

  return [
    ...savedLines,
    t("guideApply", { name: input.agentName }),
    "",
    t("guideName"),
    t("guidePersona", { list: list(choices.personas.map(named), "personas") }),
    t("guideRuntime", { list: AGENT_RUNTIMES.join(", ") }),
    t("guideModel"),
    t("guideEtaModels", { list: list(choices.models, "models") }),
    ...runtimeLines,
    t("guideThinking", { list: THINKING_LEVELS.join(", ") }),
    t("guideMachine", { list: list(choices.machines.map(named), "machines") }),
    t("guidePlugins", {
      list: list(
        choices.plugins.map(({ name, needsConfig }) =>
          needsConfig ? t("needsConfig", { name }) : name,
        ),
        "plugins",
      ),
    }),
    t("guideInstructions"),
  ].map(oneLine);
}
