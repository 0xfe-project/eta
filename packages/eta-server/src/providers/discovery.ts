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
import type { ProviderHeaders } from "@eta/client-contracts";
import type { ProviderReference } from "./catalog";
import type { EtaModelConfig, ModelInput } from "./config-types";
import { providerDefinitionForKind, resolveConfiguredModels } from "./catalog";
import { sanitizeProviderHeaders } from "./config-types";

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
  /** Why nothing came back, when nothing did. */
  error?: string;
}

/** Whether this provider's models come from its own endpoint. */
export function discoversModels(reference: ProviderReference): boolean {
  const definition = providerDefinitionForKind(reference.kind);
  return definition?.discovery.adapter === "openai-models";
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
    definition === undefined ||
    definition.discovery.adapter !== "openai-models"
  ) {
    return { models: [], error: "this provider does not publish a model list" };
  }
  const send = options.fetch ?? fetch;
  const url = `${options.reference.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  // The key is auth; the configured headers ride on top, so a `User-Agent` reaches discovery
  // exactly as it reaches a generation request.
  if (options.apiKey !== undefined && options.apiKey.length > 0)
    headers.Authorization = `Bearer ${options.apiKey}`;
  for (const [name, value] of Object.entries(
    sanitizeProviderHeaders(options.headers) ?? {},
  )) {
    if (value === null) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase())
          delete headers[existing];
      }
      continue;
    }
    headers[name] = value;
  }

  let response: Response;
  try {
    response = await send(url, {
      method: "GET",
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok)
    return { models: [], error: `the model list came back ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { models: [], error: "the model list was not JSON" };
  }
  const entries = (body as { data?: unknown })?.data;
  if (!Array.isArray(entries))
    return { models: [], error: "the model list had no data array" };

  const requiresWindow = discoveryRequiresContextWindow(options.reference);
  const discovered: EtaModelConfig[] = [];
  for (const raw of entries) {
    const entry = raw as {
      id?: unknown;
      name?: unknown;
      display_name?: unknown;
      context_window?: unknown;
      contextWindow?: unknown;
      context_length?: unknown;
      max_tokens?: unknown;
      max_output_tokens?: unknown;
      reasoning?: unknown;
      modalities?: unknown;
    };
    if (typeof entry?.id !== "string" || entry.id.trim().length === 0) continue;
    const contextWindow =
      numberOr(entry.context_window) ??
      numberOr(entry.contextWindow) ??
      numberOr(entry.context_length);
    const maxTokens =
      numberOr(entry.max_tokens) ?? numberOr(entry.max_output_tokens);
    if (contextWindow === undefined && requiresWindow) continue;
    const name = textOf(entry.display_name) ?? textOf(entry.name);
    const input = inputsOf(entry.modalities);
    discovered.push({
      id: entry.id.trim(),
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
      ...(entry.reasoning === true ? { reasoning: true } : {}),
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

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

/** The input kinds, when the endpoint names them (`modalities.input`). */
function inputsOf(modalities: unknown): ModelInput[] | undefined {
  const values = (modalities as { input?: unknown } | null | undefined)?.input;
  if (!Array.isArray(values)) return undefined;
  const inputs = values.filter(
    (value): value is ModelInput => value === "text" || value === "image",
  );
  return inputs.length === 0 ? undefined : [...new Set(inputs)];
}
