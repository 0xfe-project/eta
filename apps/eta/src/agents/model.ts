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
