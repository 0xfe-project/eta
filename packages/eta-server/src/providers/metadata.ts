/**
 * models.dev: the one public model catalog this server reads, and the one way it reads it.
 *
 * Two callers share the fetch and the parse:
 *
 * - **Metadata** (`publicModelMetadata`) fills in names, context windows and inputs for the model
 *   IDs a provider's own list returned, and only for exact official endpoints — never provider
 *   names or arbitrary compatible proxies. Discovery asks for it in the same call that lists the
 *   models, so a settings page gets both at once. Eta Token Plan is the one gateway whose models
 *   are looked up by id across every provider instead (`modelsDevByModelId`).
 * - **Discovery** for providers whose model list *is* their models.dev entry (OpenCode Zen and Go,
 *   see `discovery.ts`), where every listed model is parsed.
 *
 * Public data only: the request carries no account credentials, no headers of the user's, and
 * follows no redirects.
 */
import type { ProviderKind } from "@eta/client-contracts";
import type { ModelCapabilities } from "./config-types";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { MODEL_THINKING_LEVELS } from "./config-types";

export const MODELS_DEV_URL = "https://models.dev/api.json";

// Exact official endpoints, not provider names or arbitrary compatible proxies.
const ENDPOINTS: Record<string, string> = {
  [BUILTIN_PROVIDER_PRESETS.deepseek.baseUrl]: "deepseek",
  [BUILTIN_PROVIDER_PRESETS["kimi-coding"].baseUrl]: "kimi-code-plan-cn",
  [BUILTIN_PROVIDER_PRESETS["zai-coding-cn"].baseUrl]: "zhipuai-coding-plan",
  [BUILTIN_PROVIDER_PRESETS.zai.baseUrl]: "zai-coding-plan",
  [BUILTIN_PROVIDER_PRESETS.opencode.baseUrl]: "opencode",
  [BUILTIN_PROVIDER_PRESETS["opencode-go"].baseUrl]: "opencode-go",
  "https://api.openai.com/v1": "openai",
};

/** The models.dev entry an exact official endpoint is listed under, when it is one. */
export function officialModelsDevId(baseUrl: string): string | undefined {
  try {
    return ENDPOINTS[new URL(baseUrl.trim()).href.replace(/\/+$/, "")];
  } catch {
    return undefined;
  }
}

/** Fetch the whole catalog: a map of provider id to provider entry. */
export async function fetchModelsDev(
  send: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(45_000),
): Promise<Record<string, unknown>> {
  const response = await send(MODELS_DEV_URL, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error(`Public model metadata HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid public model metadata: expected a provider map");
  return body as Record<string, unknown>;
}

/** One provider's entry: its default protocol package and endpoint, and its raw models. */
export interface ModelsDevProvider {
  id: string;
  npm?: string;
  api?: string;
  models: Record<string, unknown>;
}

/** A provider's entry, `undefined` when the catalog has none, or the error when it is malformed. */
export function modelsDevProvider(
  body: Record<string, unknown>,
  providerId: string,
): ModelsDevProvider | undefined {
  if (!Object.hasOwn(body, providerId)) return undefined;
  const provider = body[providerId] as
    | { id?: unknown; npm?: unknown; api?: unknown; models?: unknown }
    | undefined;
  if (
    !provider ||
    typeof provider !== "object" ||
    provider.id !== providerId ||
    !provider.models ||
    typeof provider.models !== "object" ||
    Array.isArray(provider.models)
  )
    throw new Error("Invalid public model metadata: provider models");
  return {
    id: providerId,
    ...(typeof provider.npm === "string" ? { npm: provider.npm } : {}),
    ...(typeof provider.api === "string" ? { api: provider.api } : {}),
    models: provider.models as Record<string, unknown>,
  };
}

/** One listed model: what it can do, plus how and where the catalog says it is served. */
export interface ModelsDevModel extends ModelCapabilities {
  id: string;
  /** The AI SDK package that speaks its protocol; the provider's when the model names none. */
  npm?: string;
  /** Its endpoint; the provider's when the model names none. */
  api?: string;
  deprecated?: boolean;
}

const EFFORTS = MODEL_THINKING_LEVELS.filter((level) => level !== "off");

function invalid(field: string): Error {
  return new Error(`Invalid public model metadata: ${field}`);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw invalid(field);
  return value;
}

/**
 * Parse one model entry. Strict: a field that is present but malformed is an error, because a
 * catalog that says something wrong about a model is not one to guess around.
 */
export function parseModelsDevModel(
  id: string,
  raw: unknown,
  provider: Pick<ModelsDevProvider, "npm" | "api">,
): ModelsDevModel {
  const entry = raw as {
    id?: unknown;
    name?: unknown;
    status?: unknown;
    reasoning?: unknown;
    reasoning_options?: unknown;
    limit?: { context?: unknown; output?: unknown };
    modalities?: { input?: unknown };
    provider?: { npm?: unknown; api?: unknown };
  } | null;
  if (entry?.id !== id) throw invalid("model id");
  const model: ModelsDevModel = { id };
  if (entry.name !== undefined) {
    if (typeof entry.name !== "string" || !entry.name.trim())
      throw invalid("name");
    model.name = entry.name;
  }
  if (entry.limit?.context !== undefined)
    model.contextWindow = positiveInteger(entry.limit.context, "context limit");
  if (entry.limit?.output !== undefined) {
    const output = positiveInteger(entry.limit.output, "output limit");
    if (model.contextWindow !== undefined && output > model.contextWindow)
      throw invalid("output limit");
    model.maxTokens = output;
  }
  if (entry.modalities?.input !== undefined) {
    if (
      !Array.isArray(entry.modalities.input) ||
      entry.modalities.input.some((value: unknown) => typeof value !== "string")
    )
      throw invalid("input modalities");
    const input = entry.modalities.input.filter(
      (value): value is "text" | "image" =>
        value === "text" || value === "image",
    );
    if (input.length > 0) model.input = input;
  }
  if (entry.reasoning !== undefined) {
    if (typeof entry.reasoning !== "boolean") throw invalid("reasoning");
    model.reasoning = entry.reasoning;
  }
  if (model.reasoning === true && Array.isArray(entry.reasoning_options)) {
    // `effort` options name the levels the model takes; `none` among them is its off switch.
    // A `toggle` or a token budget names no level eta could send, so it adds none.
    const values = new Set<string>();
    for (const option of entry.reasoning_options as unknown[]) {
      const { type, values: listed } = (option ?? {}) as {
        type?: unknown;
        values?: unknown;
      };
      if (type !== "effort") continue;
      if (
        !Array.isArray(listed) ||
        listed.some((value) => typeof value !== "string")
      )
        throw invalid("reasoning options");
      for (const value of listed as string[]) values.add(value);
    }
    model.reasoningEfforts = EFFORTS.filter((level) => values.has(level));
    if (values.has("none")) model.thinkingMode = "both";
  } else if (
    entry.reasoning_options !== undefined &&
    entry.reasoning_options !== null &&
    !Array.isArray(entry.reasoning_options)
  )
    throw invalid("reasoning options");
  if (entry.status !== undefined) {
    if (typeof entry.status !== "string") throw invalid("status");
    if (entry.status === "deprecated") model.deprecated = true;
  }
  const own = entry.provider;
  if (own !== undefined && (typeof own !== "object" || own === null))
    throw invalid("model provider");
  for (const key of ["npm", "api"] as const) {
    const value = own?.[key] ?? provider[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw invalid(key);
    model[key] = value;
  }
  return model;
}

/**
 * Providers that make the models they list, in the order they win a tie. A gateway's
 * `claude-sonnet-5` is Anthropic's model, and Anthropic's entry is the one that says what it is;
 * a reseller's entry for the same id may carry its own, smaller limits.
 */
const MAKERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "moonshotai",
  "zai",
  "zhipuai",
  "alibaba",
  "mistral",
  "minimax",
] as const;

type ModelFacts = { id: string } & ModelCapabilities;

/**
 * What models.dev says about each model id, wherever it lists it: for a gateway (Eta Token Plan)
 * whose ids are other makers' and whose address is in no entry.
 *
 * The rules, in order:
 *
 * 1. A provider lists the model when its `models` has the id as a key, exactly; only when no
 *    provider does is the id compared without case.
 * 2. Among the providers that list it, a maker in `MAKERS` wins, in that order; otherwise the
 *    provider whose id sorts first, so the answer does not depend on the catalog's key order.
 * 3. An entry that does not parse is passed over for the next one.
 * 4. What is taken is what the model is: its name, context window, output limit, inputs, and
 *    whether and how it reasons. Its protocol, endpoint and status are the provider's, not the
 *    model's, and are left out.
 * 5. An id no provider lists gets nothing: unknown stays unknown.
 */
export function modelsDevByModelId(
  body: Record<string, unknown>,
  modelIds: readonly string[],
): ModelFacts[] {
  const providers: ModelsDevProvider[] = [];
  for (const providerId of Object.keys(body).sort()) {
    try {
      const provider = modelsDevProvider(body, providerId);
      if (provider !== undefined) providers.push(provider);
    } catch {
      // One malformed entry is not a reason to know nothing about the rest.
    }
  }
  const rank = (provider: ModelsDevProvider) => {
    const index = (MAKERS as readonly string[]).indexOf(provider.id);
    return index === -1 ? MAKERS.length : index;
  };
  providers.sort((left, right) => rank(left) - rank(right));

  const found: ModelFacts[] = [];
  for (const id of modelIds) {
    const lower = id.toLowerCase();
    const listings = (exact: boolean) =>
      providers.flatMap((provider) => {
        const key = exact
          ? Object.hasOwn(provider.models, id)
            ? id
            : undefined
          : Object.keys(provider.models).find(
              (candidate) => candidate.toLowerCase() === lower,
            );
        return key === undefined ? [] : [{ provider, key }];
      });
    const candidates = listings(true);
    for (const { provider, key } of candidates.length > 0
      ? candidates
      : listings(false)) {
      let parsed: ModelsDevModel;
      try {
        parsed = parseModelsDevModel(key, provider.models[key], provider);
      } catch {
        continue;
      }
      const {
        id: _id,
        npm: _npm,
        api: _api,
        deprecated: _deprecated,
        ...facts
      } = parsed;
      found.push({ id, ...facts });
      break;
    }
  }
  return found;
}

/** Names, context windows and inputs for explicit model IDs at an exact official endpoint. */
export async function publicModelMetadata(
  args: { kind: ProviderKind; baseUrl: string; modelIds: readonly string[] },
  send: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ models: ({ id: string } & ModelCapabilities)[] }> {
  let url: URL;
  try {
    url = new URL(args.baseUrl.trim());
  } catch {
    throw new Error("Invalid endpoint for public model metadata");
  }
  const endpoint = url.href.replace(/\/+$/, "");
  if (args.kind === "eta")
    return endpoint === BUILTIN_PROVIDER_PRESETS.eta.baseUrl
      ? {
          models: modelsDevByModelId(
            await fetchModelsDev(send, signal),
            args.modelIds,
          ),
        }
      : { models: [] };
  const providerId = ENDPOINTS[endpoint];
  const preset =
    BUILTIN_PROVIDER_PRESETS[
      args.kind as keyof typeof BUILTIN_PROVIDER_PRESETS
    ];
  if (
    !providerId ||
    (!preset &&
      args.kind !== "openai-compatible" &&
      args.kind !== "openai-responses") ||
    (preset && preset.baseUrl !== endpoint) ||
    args.kind === "openai-codex"
  )
    return { models: [] };

  const provider = modelsDevProvider(
    await fetchModelsDev(send, signal),
    providerId,
  );
  if (provider === undefined) return { models: [] };

  const models: ({ id: string } & ModelCapabilities)[] = [];
  for (const id of args.modelIds) {
    if (!Object.hasOwn(provider.models, id)) continue;
    const parsed = parseModelsDevModel(id, provider.models[id], provider);
    // What identifies it and what it takes in; the rest is the provider's own list's.
    models.push({
      id,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.contextWindow === undefined
        ? {}
        : { contextWindow: parsed.contextWindow }),
      ...(parsed.input === undefined ? {} : { input: parsed.input }),
    });
  }
  return { models };
}
