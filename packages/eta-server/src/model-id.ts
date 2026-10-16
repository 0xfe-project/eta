/**
 * `provider:modelId`, or a bare id — parsed in one place.
 *
 * The rule is eta-agent's: a bare id means the default provider (Anthropic), because that is
 * what a person types when they mean "the usual one". Two copies of this in one package meant
 * a bare id was a provider named after the model in one path and Anthropic in another; this is
 * the one answer both paths use.
 */
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

/** The default provider a bare model id belongs to. */
export const DEFAULT_PROVIDER = "anthropic";

export function parseModelId(model: string): ModelIdentity {
  const separator = model.indexOf(":");
  if (separator <= 0) return { provider: DEFAULT_PROVIDER, modelId: model };
  return {
    provider: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

/** Back to the one string a sidebar, a meta row and an op argument all use. */
export function formatModelId(identity: ModelIdentity): string {
  return `${identity.provider}:${identity.modelId}`;
}
