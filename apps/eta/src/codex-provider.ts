/**
 * The codex provider, as a runtime.
 *
 * pi-ai ships the provider (its OAuth flow, its request shapes); what this file adds is the one
 * thing an app decides: **which of its models the user actually selected**. A provider that
 * serves everything it knows would offer models the config file never listed, and a settings page
 * that shows one list while the runtime serves another is a page that lies.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { EtaModelConfig } from "./providers/config-types";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerModelCatalog } from "./providers/catalog";

/** The provider, restricted to the models the config lists (or all of them when it lists none). */
export function codexRuntimeProvider(
  configured?: EtaModelConfig[],
): Provider<Api> {
  const provider = openaiCodexProvider();
  if (configured === undefined) return provider;
  const selected = new Set(configured.map((model) => model.id));
  return {
    ...provider,
    getModels: (): readonly Model<Api>[] =>
      provider.getModels().filter((model) => selected.has(model.id)),
  };
}

/** The models a codex login serves, from the checked-in catalog. */
export function codexCatalog(): EtaModelConfig[] {
  return providerModelCatalog({
    kind: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  });
}
