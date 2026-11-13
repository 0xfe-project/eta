/**
 * Discovery: asking a provider what models it serves, and writing down what came back.
 *
 * A provider with `openai-models` discovery gets a `fetchModels` that hits its `/models`
 * endpoint with the same headers and key every other request uses — the discovery path is not a
 * second, differently-configured client, which is exactly the bug that made custom `User-Agent`
 * endpoints work for chat and fail for the model list.
 *
 * Two rules shape the answer:
 *
 * - **A model with no context window is not usable.** pi-ai needs a window to size a request and
 *   to decide when to compact; a discovered model without one is skipped rather than assumed to
 *   have some default, because guessing here is how a 1M-token model gets compacted at 128k.
 * - **Discovery fills gaps, it does not erase choices.** A model the user already configured
 *   keeps its name, its `defaultThinking`, its overrides, and its headers; what discovery adds is
 *   the capability metadata the endpoint knows and the config file does not.
 */
import type {
  ModelApi,
  ProviderCheck,
  ProviderHeaders,
  UnsupportedModel,
} from "@eta/client-contracts";
import type { ProviderReference } from "./catalog";
import type { EtaModelConfig } from "./config-types";
import { attributionHeaders } from "./attribution";
import { providerDefinitionForKind, resolveConfiguredModels } from "./catalog";
import { applyProviderHeaders } from "./config-types";
import {
  fetchModelsDev,
  modelsDevProvider,
  parseModelsDevModel,
  publicModelMetadata,
} from "./metadata";

/** What a discovery call needs: where to ask, how to authenticate, and who to tell. */
export interface DiscoveryOptions {
  reference: ProviderReference;
  apiKey?: string | undefined;
  headers?: ProviderHeaders | undefined;
  /** The HTTP client; a test supplies one and inspects the request it was handed. */
  fetch?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
}

export interface DiscoveryResult {
  models: EtaModelConfig[];
  /** Listed by the provider's catalog, but not usable through this provider (models.dev only). */
  unsupported?: UnsupportedModel[];
  /** Why nothing came back, when nothing did. */
  error?: string;
  failure?: "unsupported" | "network" | "http" | "response";
  status?: number;
}

/** Whether this provider's models come from its own endpoint. */
export function discoversModels(reference: ProviderReference): boolean {
  const definition = providerDefinitionForKind(reference.kind);
  return (
    definition?.discovery.adapter === "openai-models" ||
    definition?.discovery.adapter === "models-dev"
  );
}

/** Whether a discovered model has to declare a context window to be usable. */
export function discoveryRequiresContextWindow(
  reference: ProviderReference,
): boolean {
  return (
    providerDefinitionForKind(reference.kind)?.discovery
      .requireContextWindow === true
  );
}

/**
 * Ask a provider for its model list.
 *
 * The shape is OpenAI's `/models` (`{ data: [{ id, ... }] }`); a provider that answers with
 * something else is reported rather than guessed at, because a silently empty list looks exactly
 * like "this provider serves nothing".
 */
export async function discoverModels(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const definition = providerDefinitionForKind(options.reference.kind);
  if (
    definition?.discovery.adapter === "models-dev" &&
    definition.discovery.provider !== undefined
  )
    return await discoverFromModelsDev(options, definition.discovery.provider);
  if (
    definition === undefined ||
    definition.discovery.adapter !== "openai-models"
  ) {
    return {
      models: [],
      error: "this provider does not publish a model list",
      failure: "unsupported",
    };
  }
  const send = options.fetch ?? fetch;
  const url = `${options.reference.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...attributionHeaders(options.reference.baseUrl, options.headers),
  };
  // The key is auth; the configured headers ride on top, so a `User-Agent` reaches discovery
  // exactly as it reaches a generation request.
  if (options.apiKey !== undefined && options.apiKey.length > 0)
    headers.Authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  try {
    response = await send(url, {
      method: "GET",
      headers: applyProviderHeaders(headers, options.headers),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
      failure: "network",
    };
  }
  if (!response.ok)
    return {
      models: [],
      error: `the model list came back ${response.status}`,
      failure: "http",
      status: response.status,
    };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      models: [],
      error: "the model list was not JSON",
      failure: "response",
    };
  }
  const entries = (body as { data?: unknown })?.data;
  if (!Array.isArray(entries))
    return {
      models: [],
      error: "the model list had no data array",
      failure: "response",
    };

  const requiresWindow = discoveryRequiresContextWindow(options.reference);
  const discovered: EtaModelConfig[] = [];
  for (const raw of entries) {
    const entry = raw as {
      id?: unknown;
      context_window?: unknown;
      contextWindow?: unknown;
      max_tokens?: unknown;
    };
    if (typeof entry?.id !== "string" || entry.id.trim().length === 0) continue;
    const contextWindow =
      numberOr(entry.context_window) ?? numberOr(entry.contextWindow);
    const maxTokens = numberOr(entry.max_tokens);
    if (contextWindow === undefined && requiresWindow) continue;
    discovered.push({
      id: entry.id.trim(),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  // What the catalog knows about these models is merged in, and the user's own entries keep
  // whatever they declared.
  const merged = resolveConfiguredModels(options.reference, discovered);
  return { models: merged };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * The AI SDK packages whose protocol eta speaks, and as which API. `@ai-sdk/openai` is the
 * Responses API (it is what the AI SDK's `openai()` provider posts to); Anthropic Messages,
 * Gemini and Mistral are listed as unsupported until eta speaks them.
 */
const MODELS_DEV_PROTOCOLS: Readonly<Record<string, ModelApi>> = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/openai": "openai-responses",
};

function sameEndpoint(left: string, right: string): boolean {
  try {
    return (
      new URL(left).href.replace(/\/+$/, "") ===
      new URL(right).href.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/**
 * A provider whose model list is its models.dev entry: no key is involved (the catalog is
 * public), and every listed model is accounted for — usable ones in `models`, the rest in
 * `unsupported` with the reason, so a model never just goes missing.
 *
 * A model is usable when its protocol is one eta speaks *and* its endpoint is this provider's
 * base URL. The second rule is about the key: the catalog is someone else's data, and a model
 * listed at another address must not be where this provider's key is sent.
 *
 * Deprecated models are returned with `deprecated: true`; whether to offer them is the caller's.
 */
async function discoverFromModelsDev(
  options: DiscoveryOptions,
  providerId: string,
): Promise<DiscoveryResult> {
  let provider;
  try {
    provider = modelsDevProvider(
      await fetchModelsDev(options.fetch ?? fetch, options.signal),
      providerId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /HTTP (\d{3})$/.exec(message)?.[1];
    if (status !== undefined)
      return {
        models: [],
        error: `the model list came back ${status}`,
        failure: "http",
        status: Number(status),
      };
    return {
      models: [],
      error: message,
      failure: message.startsWith("Invalid public model metadata")
        ? "response"
        : "network",
    };
  }
  if (provider === undefined)
    return {
      models: [],
      error: `models.dev has no ${providerId} entry`,
      failure: "response",
    };
  const models: EtaModelConfig[] = [];
  const unsupported: UnsupportedModel[] = [];
  for (const id of Object.keys(provider.models)) {
    let parsed;
    try {
      parsed = parseModelsDevModel(id, provider.models[id], provider);
    } catch {
      unsupported.push({ id, protocol: "", reason: "invalid" });
      continue;
    }
    const { npm, api: endpoint, ...capabilities } = parsed;
    const api = npm === undefined ? undefined : MODELS_DEV_PROTOCOLS[npm];
    if (api === undefined) {
      unsupported.push({
        id,
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        protocol: npm ?? "",
        reason: "protocol",
      });
      continue;
    }
    if (
      endpoint === undefined ||
      !sameEndpoint(endpoint, options.reference.baseUrl)
    ) {
      unsupported.push({
        id,
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        protocol: npm ?? "",
        reason: "endpoint",
      });
      continue;
    }
    models.push({ ...capabilities, api });
  }
  return { models, unsupported };
}

/** Whether this kind lists its models from models.dev rather than from its own endpoint. */
function listsModelsDev(reference: ProviderReference): boolean {
  return (
    providerDefinitionForKind(reference.kind)?.discovery.adapter ===
    "models-dev"
  );
}

/**
 * Ask the provider's own `/models` with the key, for the answer alone: a gateway whose model list
 * is public (OpenCode) still says 401 to a key it does not know, and that is the only way to learn
 * the key is wrong before a chat fails on it.
 */
async function probeKey(
  options: DiscoveryOptions,
): Promise<DiscoveryResult | undefined> {
  const send = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...attributionHeaders(options.reference.baseUrl, options.headers),
  };
  if (options.apiKey !== undefined && options.apiKey.length > 0)
    headers.Authorization = `Bearer ${options.apiKey}`;
  let response: Response;
  try {
    response = await send(
      `${options.reference.baseUrl.replace(/\/+$/, "")}/models`,
      {
        method: "GET",
        headers: applyProviderHeaders(headers, options.headers),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
      failure: "network",
    };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return undefined;
  return {
    models: [],
    error: `the model list came back ${response.status}`,
    failure: "http",
    status: response.status,
  };
}

/**
 * The model list and what models.dev knows about it, in one call: what a settings page offers
 * when a provider is added or its list refreshed.
 *
 * - A provider that lists its own models (`/models`) is asked with the key and headers; its
 *   official endpoint then gets names, context windows and inputs from models.dev for whatever
 *   the list left out. The catalog is a supplement: when it cannot be read, the list stands.
 * - A provider whose list is models.dev (OpenCode) gets the catalog, and the key, when there is
 *   one, is tried against the gateway's own `/models` so a wrong key is caught here.
 */
export async function listProviderModels(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const discovered = await discoverModels(options);
  if (discovered.failure !== undefined) return discovered;
  if (listsModelsDev(options.reference)) {
    if (options.apiKey === undefined || options.apiKey.length === 0)
      return discovered;
    return (await probeKey(options)) ?? discovered;
  }
  if (discovered.models.length === 0) return discovered;
  let known: Awaited<ReturnType<typeof publicModelMetadata>>["models"];
  try {
    known = (
      await publicModelMetadata(
        {
          kind: options.reference.kind ?? "openai-compatible",
          baseUrl: options.reference.baseUrl,
          modelIds: discovered.models.map((model) => model.id),
        },
        options.fetch ?? fetch,
        options.signal,
      )
    ).models;
  } catch {
    return discovered;
  }
  const facts = new Map(known.map((model) => [model.id, model]));
  return {
    ...discovered,
    models: discovered.models.map((model) => {
      const found = facts.get(model.id);
      if (found === undefined) return model;
      // The provider's own answer and the built-in catalog win; models.dev fills the gaps.
      return {
        ...(found.name === undefined ? {} : { name: found.name }),
        ...(found.contextWindow === undefined
          ? {}
          : { contextWindow: found.contextWindow }),
        ...(found.input === undefined ? {} : { input: found.input }),
        ...model,
      };
    }),
  };
}

/**
 * Whether a provider answers with this key: its model list is the probe, and nothing is written.
 * models.dev kinds are asked their gateway's `/models`, since the catalog says nothing of the key.
 */
export async function checkConnection(
  options: DiscoveryOptions,
): Promise<Omit<ProviderCheck, "checkedAt">> {
  const result = listsModelsDev(options.reference)
    ? ((await probeKey(options)) ?? { models: [] })
    : await discoverModels(options);
  if (options.signal?.aborted === true)
    return { state: "unreachable", error: "discovery_timeout" };
  if (result.failure === undefined) return { state: "ok" };
  return checkOf(result);
}

/** A failed listing as a check: the key refused, or anything else that kept the list away. */
export function checkOf(
  result: Pick<DiscoveryResult, "failure" | "status">,
): Omit<ProviderCheck, "checkedAt"> {
  if (
    result.failure === "http" &&
    (result.status === 401 || result.status === 403)
  )
    return { state: "invalid_key", error: `discovery_http_${result.status}` };
  return {
    state: "unreachable",
    error:
      result.failure === "http"
        ? `discovery_http_${result.status}`
        : `discovery_${result.failure ?? "response"}`,
  };
}
