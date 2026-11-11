/** Public metadata only: no account credentials, discovery or configuration writes. */
import type { ProviderArgs } from "@eta/client-contracts";
import type { ModelCapabilities } from "./config-types";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";

// Exact official endpoints, not provider names or arbitrary compatible proxies.
const ENDPOINTS: Record<string, string> = {
  [BUILTIN_PROVIDER_PRESETS.deepseek.baseUrl]: "deepseek",
  [BUILTIN_PROVIDER_PRESETS["kimi-coding"].baseUrl]: "kimi-code-plan-cn",
  [BUILTIN_PROVIDER_PRESETS["zai-coding-cn"].baseUrl]: "zhipuai-coding-plan",
  [BUILTIN_PROVIDER_PRESETS.zai.baseUrl]: "zai-coding-plan",
  "https://api.openai.com/v1": "openai",
};

export async function publicModelMetadata(
  args: ProviderArgs["metadata"],
  send: typeof fetch = fetch,
): Promise<{ models: ({ id: string } & ModelCapabilities)[] }> {
  let url: URL;
  try {
    url = new URL(args.baseUrl.trim());
  } catch {
    throw new Error("Invalid endpoint for public model metadata");
  }
  const endpoint = url.href.replace(/\/+$/, "");
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

  const response = await send("https://models.dev/api.json", {
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok)
    throw new Error(`Public model metadata HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid public model metadata: expected a provider map");
  const provider = (
    body as Record<
      string,
      {
        id?: unknown;
        models?: Record<
          string,
          {
            id?: unknown;
            name?: unknown;
            limit?: { context?: unknown };
            modalities?: { input?: unknown };
          }
        >;
      }
    >
  )[providerId];
  if (provider === undefined) return { models: [] };
  if (
    provider.id !== providerId ||
    !provider.models ||
    typeof provider.models !== "object" ||
    Array.isArray(provider.models)
  )
    throw new Error("Invalid public model metadata: provider models");

  const models: ({ id: string } & ModelCapabilities)[] = [];
  for (const id of args.modelIds) {
    if (!Object.hasOwn(provider.models, id)) continue;
    const entry = provider.models[id];
    if (entry?.id !== id)
      throw new Error("Invalid public model metadata: model id");
    const model: { id: string } & ModelCapabilities = { id };
    if (entry.name !== undefined) {
      if (typeof entry.name !== "string" || !entry.name.trim())
        throw new Error("Invalid public model metadata: name");
      model.name = entry.name;
    }
    if (entry.limit?.context !== undefined) {
      if (
        typeof entry.limit.context !== "number" ||
        !Number.isSafeInteger(entry.limit.context) ||
        entry.limit.context <= 0
      )
        throw new Error("Invalid public model metadata: context limit");
      model.contextWindow = entry.limit.context;
    }
    if (entry.modalities?.input !== undefined) {
      if (
        !Array.isArray(entry.modalities.input) ||
        entry.modalities.input.some(
          (value: unknown) => typeof value !== "string",
        )
      )
        throw new Error("Invalid public model metadata: input modalities");
      const input = entry.modalities.input.filter(
        (value): value is "text" | "image" =>
          value === "text" || value === "image",
      );
      if (input.length > 0) model.input = input;
    }
    models.push(model);
  }
  return { models };
}
