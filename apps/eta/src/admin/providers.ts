import type {
  EtaConfig,
  EtaModelConfig,
  EtaProviderConfig,
} from "../providers/config-types";
/**
 * Reading and editing the providers in `~/.eta/config.json`.
 *
 * The file is the source of truth for what a host can talk to, and it is the same file a person
 * may edit by hand — so an editor on top of it has two jobs beyond "save": say what is in there
 * without leaking a key, and change as little as possible when it writes.
 *
 * Three rules, all of them about not being a nuisance:
 *
 * - **A key never leaves.** `GET` answers `has_key`, not the key. A page that can read secrets is
 *   a page that can leak them, and nothing in the editor needs to show one to replace it.
 * - **Unknown fields survive.** The config has grown fields this file has never heard of (and will
 *   again). Editing one provider rewrites that provider and nothing else — no normalising the rest
 *   of the file into what this build happens to know.
 * - **A change is a restart.** Providers are built once at startup and handed to sessions; swapping
 *   them under a running session would change the model a conversation is on mid-answer. So the
 *   write is honest about it: the answer says `restart_required`, and the interface says so too.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { MODEL_THINKING_LEVELS } from "../providers/config-types";

/** What the editor sees of a provider. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  /** Whether a key is configured — never the key itself. */
  has_key: boolean;
  headers: Record<string, string | null>;
  models: {
    id: string;
    name: string | null;
    context_window: number | null;
    input: string[];
    /** Whether it can think at all, and at which levels: what the model list shows. */
    reasoning: boolean;
    thinking_mode: string;
    levels: string[];
  }[];
}

export function providerView(provider: EtaProviderConfig): ProviderView {
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    kind: provider.kind ?? "openai-compatible",
    baseUrl: provider.baseUrl,
    has_key: typeof provider.apiKey === "string" && provider.apiKey.length > 0,
    headers: { ...(provider.headers ?? {}) },
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name ?? null,
      context_window: model.contextWindow ?? null,
      input: [...(model.input ?? [])],
      reasoning: model.reasoning === true,
      thinking_mode: model.thinkingMode ?? "no",
      levels: [...(model.reasoningEfforts ?? [])],
    })),
  };
}

export class ProviderEditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

function asModels(value: unknown): EtaModelConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ProviderEditError("BAD_MODELS", "models 必须是一个数组。");
  }
  const models: EtaModelConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new ProviderEditError("BAD_MODELS", "每个 model 必须是对象。");
    }
    const record = entry as Record<string, unknown>;
    const id = asString(record.id);
    if (id === undefined) {
      throw new ProviderEditError("BAD_MODELS", "model 需要一个 id。");
    }
    const input = Array.isArray(record.input)
      ? record.input.filter(
          (item): item is "text" | "image" =>
            item === "text" || item === "image",
        )
      : undefined;
    const thinking = Array.isArray(record.thinking)
      ? record.thinking.filter(
          (item): item is (typeof MODEL_THINKING_LEVELS)[number] =>
            typeof item === "string" &&
            (MODEL_THINKING_LEVELS as readonly string[]).includes(item),
        )
      : undefined;
    models.push({
      id,
      ...(asString(record.name) === undefined
        ? {}
        : { name: asString(record.name)! }),
      ...(typeof record.contextWindow === "number"
        ? { contextWindow: record.contextWindow }
        : {}),
      ...(input === undefined || input.length === 0 ? {} : { input }),
      ...(thinking === undefined || thinking.length === 0 ? {} : { thinking }),
    });
  }
  if (models.length === 0) {
    throw new ProviderEditError(
      "BAD_MODELS",
      "一个 provider 至少要有一个 model。",
    );
  }
  return models;
}

function asHeaders(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderEditError("BAD_HEADERS", "headers 必须是对象。");
  }
  const headers: Record<string, string | null> = {};
  for (const [name, header] of Object.entries(value)) {
    const key = name.trim();
    if (key.length === 0) continue;
    // `null` is how the config says "send this header as nothing" (it suppresses a provider
    // default); an empty string means the same thing and is stored as null.
    headers[key] =
      typeof header === "string" && header.trim().length > 0
        ? header.trim()
        : null;
  }
  return headers;
}

/**
 * The provider after `patch`, or a `ProviderEditError` explaining which field made no sense.
 *
 * `apiKey: null` clears the key, `apiKey` absent leaves it alone. That distinction is the whole
 * reason this is not a spread: a form that submits nothing for an untouched key must not erase it.
 */
export function applyProviderPatch(
  current: EtaProviderConfig | undefined,
  patch: Record<string, unknown>,
  id: string,
): EtaProviderConfig {
  if (current === undefined && patch.baseUrl === undefined) {
    throw new ProviderEditError("BAD_BASE_URL", "新建 provider 需要 baseUrl。");
  }
  const baseUrl =
    patch.baseUrl === undefined ? current?.baseUrl : asString(patch.baseUrl);
  if (baseUrl === undefined) {
    throw new ProviderEditError("BAD_BASE_URL", "baseUrl 不能是空的。");
  }
  const models = asModels(patch.models) ?? current?.models;
  if (models === undefined || models.length === 0) {
    throw new ProviderEditError(
      "BAD_MODELS",
      "一个 provider 至少要有一个 model。",
    );
  }
  const headers = asHeaders(patch.headers);
  // `apiKey: null` clears it; absent leaves it alone. The cleared case carries `undefined`
  // explicitly so the merge overwrites the old value — `JSON.stringify` then leaves the key out.
  const clearing = patch.apiKey === null;
  const apiKey = clearing
    ? undefined
    : (asString(patch.apiKey) ?? current?.apiKey);
  return {
    ...current,
    id,
    baseUrl,
    ...(asString(patch.kind) === undefined
      ? {}
      : { kind: asString(patch.kind)! as EtaProviderConfig["kind"] }),
    ...(patch.name === null
      ? { name: undefined }
      : asString(patch.name) === undefined
        ? {}
        : { name: asString(patch.name)! }),
    ...(clearing
      ? { apiKey: undefined }
      : apiKey === undefined
        ? {}
        : { apiKey }),
    ...(headers === undefined ? {} : { headers }),
    models,
  };
}

/** The config with this provider replaced (or appended), and nothing else touched. */
export function withProvider(
  config: EtaConfig,
  provider: EtaProviderConfig,
): EtaConfig {
  const providers = [...(config.providers ?? [])];
  const at = providers.findIndex((candidate) => candidate.id === provider.id);
  if (at === -1) providers.push(provider);
  else providers[at] = { ...providers[at], ...provider };
  return { ...config, providers };
}

/** The config with this provider gone. */
export function withoutProvider(config: EtaConfig, id: string): EtaConfig {
  return {
    ...config,
    providers: (config.providers ?? []).filter(
      (provider) => provider.id !== id,
    ),
  };
}

/**
 * Write the config back, atomically.
 *
 * A half-written config is a host that cannot start: the file is written next to itself and
 * renamed over the original, which on every filesystem this runs on is one operation. Mode 0600
 * because the file holds API keys.
 */
export async function writeConfig(
  path: string,
  config: EtaConfig,
): Promise<void> {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const temporary = join(
    dirname(path),
    `.config-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** The config as it is on disk right now, so an edit is a patch on the latest file. */
export async function readConfigFile(path: string): Promise<EtaConfig> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as EtaConfig)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
