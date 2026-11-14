import type { AgentRuntime } from "@eta/client-contracts";

/**
 * An agent names a model as `provider:modelId`; an external runtime uses its own id as the
 * provider. This is the host-side shape check shared by ordinary agents and Captain.
 */
export function checkModel(runtime: AgentRuntime, model: string | null): void {
  if (model === null) return;
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1)
    throw new Error("model must be provider:modelId");
  const provider = model.slice(0, separator);
  if (runtime !== "eta" && provider !== runtime)
    throw new Error(`a ${runtime} agent runs ${runtime}:<model>, not ${model}`);
}

/**
 * An agent on eta's own loop runs on the model it names: there is no default model to fall back
 * to. An external runtime (Claude Code, Codex, ...) has its own default, so none is fine there.
 */
export function requireModel(
  runtime: AgentRuntime,
  model: string | null,
): void {
  checkModel(runtime, model);
  if (runtime === "eta" && model === null)
    throw new Error("an eta agent needs a model: choose one");
}

/**
 * Why an agent cannot run at all: on eta's own loop with no model chosen. Said when it is asked
 * to answer, rather than running it on some other model the user never picked.
 */
export function missingModel(agent: {
  name: string;
  runtime: AgentRuntime;
  model: string | null;
}): string | undefined {
  if (agent.runtime !== "eta" || agent.model !== null) return undefined;
  return `${agent.name} has no model. Choose one in ${agent.name}'s settings.`;
}

const UNAVAILABLE = /^model_unavailable: (.+)$/;

/**
 * A run that failed on a model the providers no longer have (`model_unavailable: <id>`), said as
 * what to do about it. Nothing picks another model in its place. Other errors pass unchanged.
 */
export function explainRunError(error: string): string {
  const match = UNAVAILABLE.exec(error.trim());
  if (match === null) return error;
  const model = match[1]!.replace("/", ":");
  return `The model ${model} is no longer available. Choose another one in the agent's settings.`;
}
