/**
 * An ACP agent's models, as a session's model layer.
 *
 * An agent says what it can be set to in the `configOptions` of a session it opened: the option
 * of category `model` is its models, the one of category `thought_level` its reasoning levels.
 * An agent that offers neither has no list, and its sessions run on whatever it defaults to.
 *
 * As with any external runtime the provider is the runtime's id (`acp.gemini:<model>`), and
 * nothing here generates: the agent does.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentRuntimeModel } from "@eta/client-contracts";
import type { Api, KernelModels, Model, ThinkingLevel } from "@eta/core";
import { THINKING_LEVELS } from "@eta/core";

/** One thing a session can be set to: the option's id, where it stands, what it takes. */
export interface AcpChoice {
  configId: string;
  current: string;
  values: { value: string; name: string }[];
}

export interface AcpChoices {
  model?: AcpChoice;
  effort?: AcpChoice;
}

function choiceOf(option: SessionConfigOption): AcpChoice | undefined {
  if (option.type !== "select") return undefined;
  const values: AcpChoice["values"] = [];
  for (const item of option.options) {
    if ("options" in item)
      for (const inner of item.options)
        values.push({ value: inner.value, name: inner.name });
    else values.push({ value: item.value, name: item.name });
  }
  return { configId: option.id, current: option.currentValue, values };
}

/** The model and reasoning-level options among a session's config options. */
export function choicesOf(
  options: readonly SessionConfigOption[] | null | undefined,
): AcpChoices {
  const choices: AcpChoices = {};
  for (const option of options ?? []) {
    if (option.category === "model" && choices.model === undefined) {
      const choice = choiceOf(option);
      if (choice !== undefined) choices.model = choice;
    } else if (
      option.category === "thought_level" &&
      choices.effort === undefined
    ) {
      const choice = choiceOf(option);
      if (choice !== undefined) choices.effort = choice;
    }
  }
  return choices;
}

/** The choices as a runtime's model list: every model takes the agent's reasoning levels. */
export function modelsOf(choices: AcpChoices): AgentRuntimeModel[] {
  const efforts = choices.effort?.values.map((item) => item.value) ?? [];
  return (choices.model?.values ?? []).map((item) => ({
    id: item.value,
    name: item.name,
    default: item.value === choices.model?.current,
    efforts: [...efforts],
  }));
}

/**
 * The reasoning level an agent is asked for at a thinking level: the level itself where the agent
 * has it, `minimal` falling back to `low`. `off` is the agent's `none` (or `off`) where it lists
 * one; otherwise `off`, and a level it lacks, ask for nothing.
 */
export function effortFor(
  level: ThinkingLevel,
  efforts: readonly string[],
): string | undefined {
  if (level === "off")
    return ["none", "off"].find((word) => efforts.includes(word));
  if (efforts.includes(level)) return level;
  if (level === "minimal" && efforts.includes("low")) return "low";
  return undefined;
}

function modelOf(
  runtime: string,
  id: string,
  listed: AgentRuntimeModel | undefined,
): Model<Api> {
  const efforts = listed?.efforts;
  return {
    id,
    name: listed?.name ?? id,
    api: runtime,
    provider: runtime,
    baseUrl: "",
    reasoning: efforts === undefined || efforts.length > 0,
    ...(efforts === undefined
      ? {}
      : {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.filter((level) => level !== "off").map((level) => [
              level,
              effortFor(level, efforts) ?? null,
            ]),
          ),
        }),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
}

/**
 * The session's model layer. A name resolves whether the agent lists it or not: the list is what
 * a probe saw, the agent may take more, and a name it refuses is said when the session is set.
 */
export function acpModels(
  runtime: string,
  listed: () => readonly AgentRuntimeModel[],
): KernelModels {
  const refuse = (): never => {
    throw new Error(
      `${runtime} generates on its own; eta does not call its models`,
    );
  };
  return {
    getModel: (provider: string, id: string) =>
      provider === runtime
        ? modelOf(
            runtime,
            id,
            listed().find((model) => model.id === id),
          )
        : undefined,
    streamSimple: refuse,
    completeSimple: refuse,
  } as unknown as KernelModels;
}
