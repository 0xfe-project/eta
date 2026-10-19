/**
 * Reading a host configuration file for tests (REFACTOR.md §2.2).
 *
 * The smoke test must not carry a provider id or a model name in its source:
 * it reads whatever this machine is configured for, or whatever the environment
 * names. This reader knows the shape of the eta config (`providers[]` +
 * `defaultModel`), not the contents.
 */

import type { ModelSpec, ProviderSpec } from "./real-models";
import { readFile } from "node:fs/promises";

interface RawModel {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  input?: unknown;
  reasoning?: unknown;
}

interface RawProvider {
  id?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  headers?: unknown;
  models?: unknown;
}

interface RawConfig {
  providers?: unknown;
  defaultModel?: unknown;
}

export interface SelectedProvider {
  spec: ProviderSpec;
  /** The model to run, as `provider:model` was resolved. */
  modelId: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function headers(value: unknown): Record<string, string | null> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry === "string")
      out[key] = entry as string | null;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function model(raw: RawModel): ModelSpec | undefined {
  const id = text(raw.id);
  if (id === undefined) return undefined;
  const input = Array.isArray(raw.input)
    ? raw.input.filter(
        (part): part is "text" | "image" => part === "text" || part === "image",
      )
    : undefined;
  return {
    id,
    name: text(raw.name),
    contextWindow: number(raw.contextWindow),
    maxTokens: number(raw.maxTokens),
    input:
      input === undefined || input.length === 0
        ? undefined
        : [...new Set(input)],
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
  };
}

/**
 * Read the config and pick one provider + model.
 *
 * `selector` is `provider:model`, a bare model id, or undefined — undefined
 * means the file's own `defaultModel`. Nothing is guessed from a constant.
 */
export async function selectProvider(
  configPath: string,
  selector?: string,
): Promise<SelectedProvider> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as RawConfig;
  if (!Array.isArray(raw.providers))
    throw new Error(`${configPath}: no providers array`);
  const providers = raw.providers as RawProvider[];
  const requested = selector ?? text(raw.defaultModel);
  if (requested === undefined)
    throw new Error(`${configPath}: no defaultModel and no model requested`);

  const [providerId, modelId] = requested.includes(":")
    ? [
        requested.slice(0, requested.indexOf(":")),
        requested.slice(requested.indexOf(":") + 1),
      ]
    : [undefined, requested];

  for (const candidate of providers) {
    const id = text(candidate.id);
    const baseUrl = text(candidate.baseUrl);
    if (id === undefined || baseUrl === undefined) continue;
    if (providerId !== undefined && id !== providerId) continue;
    const models = (
      Array.isArray(candidate.models) ? (candidate.models as RawModel[]) : []
    )
      .map(model)
      .filter((entry): entry is ModelSpec => entry !== undefined);
    if (modelId !== undefined && !models.some((entry) => entry.id === modelId))
      continue;
    const chosen = modelId ?? models[0]?.id;
    if (chosen === undefined) continue;
    return {
      spec: {
        id,
        baseUrl,
        apiKey: text(candidate.apiKey),
        headers: headers(candidate.headers),
        models: models.length > 0 ? models : [{ id: chosen }],
      },
      modelId: chosen,
    };
  }
  throw new Error(`${configPath}: no provider offers ${requested}`);
}
