/**
 * The rule about which models an agent may name (P0.8), in one place.
 *
 * Two surfaces ask it — the internal agents routes and the product API the web speaks — and a
 * check that lives twice is a check that will disagree with itself. The rejection is a shape, not
 * a Response, so each surface can render it its own way.
 */
import type { KernelModels } from "@eta/core";
import { formatModelId, parseModelId } from "@eta/server";

export interface ModelRejection {
  code: string;
  message: string;
}

/**
 * `undefined` when the model is fine, otherwise why it is not.
 *
 * `provider:modelId` is the form; a bare id is read as the default provider, which this host very
 * likely does not serve — and that is an answer, not a guess about which provider was meant.
 */
export function modelRejection(
  models: KernelModels | undefined,
  raw: string,
): ModelRejection | undefined {
  const identity = parseModelId(raw);
  if (models?.getModel(identity.provider, identity.modelId) !== undefined)
    return undefined;
  return {
    code: "MODEL_UNKNOWN",
    message: `no model ${formatModelId(identity)} is configured; use provider:modelId`,
  };
}
