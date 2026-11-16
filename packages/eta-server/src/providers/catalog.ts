/**
 * The models a source publishes: the ones its definition lists (`MODEL_SOURCES` in
 * `@eta/client-contracts`), with pi-ai's own facts filling in what the definition leaves out
 * (a model's real context window, whether it reasons) for the kinds pi-ai has a provider for.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderKind } from "@eta/client-contracts";
import type { EtaModelConfig } from "./config-types";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  isCustomKind,
  MODEL_SOURCES,
  modelSource,
} from "@eta/client-contracts";

/** A provider reference: what a config entry says about where it points. */
export interface ProviderReference {
  kind?: ProviderKind;
  baseUrl: string;
}

/** pi-ai's own models for a kind it has a provider of the same id for. */
export function piModels(kind: ProviderKind): Model<Api>[] {
  return getBuiltinModels(kind as never) as Model<Api>[];
}

/**
 * The Chat Completions fields the definition says a kind takes, as pi-ai's `compat`, for a kind
 * pi-ai does not recognise by its address (Eta Token Plan, Command Code). pi-ai reads any other
 * address as OpenAI itself, which sends `store`, the `developer` role and
 * `max_completion_tokens` — fields a gateway may refuse.
 */
export function catalogCompat(
  kind: ProviderKind | undefined,
): Record<string, unknown> | undefined {
  const source = modelSource(kind);
  return source?.pi === "catalog" ? undefined : source?.compat;
}

/** Which kind's models a config entry gets: its own, or the one whose endpoint it points at. */
function sourceKind(provider: ProviderReference): ProviderKind | undefined {
  if (!isCustomKind(provider.kind))
    return modelSource(provider.kind) === undefined ? undefined : provider.kind;
  let baseUrl: string;
  try {
    baseUrl = new URL(provider.baseUrl).href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  return (Object.keys(MODEL_SOURCES) as ProviderKind[]).find(
    (kind) => modelSource(kind)?.baseUrl === baseUrl,
  );
}

/** A model's capabilities as pi-ai knows them. */
function fromPiModel(model: Model<Api>): EtaModelConfig {
  return {
    id: model.id,
    name: model.name,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    ...(model.reasoning ? { reasoningEfforts: [] } : {}),
  };
}

/**
 * The models a provider serves: its definition's list, with pi-ai's facts under it. The
 * definition wins where it speaks (its context windows and thinking levels are the ones the
 * server has tested). This is metadata, not an allowlist for configured or discovered IDs.
 */
export function providerModelCatalog(
  provider: ProviderReference,
): EtaModelConfig[] {
  const kind = sourceKind(provider);
  const source = modelSource(kind);
  if (kind === undefined || source === undefined) return [];
  const pi = new Map(
    (source.pi === "catalog" ? piModels(kind) : []).map((model) => [
      model.id,
      fromPiModel(model),
    ]),
  );
  return (source.listed ?? []).map(({ id, ...capabilities }) => ({
    id,
    ...pi.get(id),
    ...structuredClone(capabilities),
  }));
}

export function providerModelDefinition(
  provider: ProviderReference,
  modelId: string,
): EtaModelConfig | undefined {
  return providerModelCatalog(provider).find((model) => model.id === modelId);
}

/** Fill exact catalog matches without treating the catalog as an allowlist. */
export function resolveConfiguredModels(
  provider: ProviderReference,
  models: EtaModelConfig[],
): EtaModelConfig[] {
  const resolved: EtaModelConfig[] = [];
  for (const model of models) {
    const known = providerModelDefinition(provider, model.id);
    resolved.push({ ...(known ?? {}), ...model, id: model.id });
  }
  return resolved;
}
