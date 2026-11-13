import type {
  LlmConnection,
  LlmConnector,
  LlmModel,
  LlmQuota,
  ProviderCheck,
  ProviderSummary,
} from "@eta/client-contracts";
import { useMemo } from "react";
import { useLlm } from "@/queries/llm";
import {
  isCustomKind,
  keyMissing,
  providerLabel,
  signsIn,
  useProviderChecks,
  useProviders,
} from "@/queries/providers";

// Model sources: one list for everything a model can come from. A provider in `config.json` (an
// API key, a custom endpoint, a model server on this machine) and an account the LLM gateway holds
// (a Codex or Grok sign-in, a Google AI Studio key) are stored in two places and stay there; the
// settings page shows them as one kind of thing, with one status vocabulary.

/**
 * What a source's row says about it. `unreachable` is a check that failed for a reason other than
 * the key; `disabled` is a gateway account someone switched off.
 */
export type SourceStatus =
  | "ok"
  | "needs_key"
  | "invalid_key"
  | "needs_login"
  | "unreachable"
  | "disabled";

/** How a provider in the config is reached, as the row names it. */
type ProviderVia = "key" | "custom" | "local" | "legacy";

interface SourceBase {
  /** Unique across both kinds: what the page addresses a source by. */
  key: string;
  name: string;
  status: SourceStatus;
  /** Models an agent can pick from it. */
  models: number;
}

export interface ProviderSource extends SourceBase {
  type: "provider";
  provider: ProviderSummary;
  via: ProviderVia;
  check?: ProviderCheck | undefined;
}

export interface AccountSource extends SourceBase {
  type: "account";
  connector: LlmConnector;
  connection: LlmConnection;
  quota?: LlmQuota | undefined;
}

export type Source = ProviderSource | AccountSource;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** Whether an address is this machine: a model server like Ollama or LM Studio. */
function isLoopback(baseUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function providerSource(
  provider: ProviderSummary,
  check: ProviderCheck | undefined,
): ProviderSource {
  const via: ProviderVia = signsIn(provider)
    ? "legacy"
    : !isCustomKind(provider.kind)
      ? "key"
      : isLoopback(provider.baseUrl)
        ? "local"
        : "custom";
  const status: SourceStatus =
    via === "legacy"
      ? "ok"
      : keyMissing(provider)
        ? "needs_key"
        : check?.state === "invalid_key"
          ? "invalid_key"
          : check?.state === "unreachable"
            ? "unreachable"
            : "ok";
  return {
    type: "provider",
    key: `provider:${provider.id}`,
    name: providerLabel(provider),
    status,
    models: provider.models.length,
    provider,
    via,
    check,
  };
}

/** An account's state in the page's words. A refused key is told apart from an expired login. */
function accountStatus(
  connection: LlmConnection,
  connector: LlmConnector,
): SourceStatus {
  switch (connection.state) {
    case "disabled":
      return "disabled";
    case "needs_login":
      return "needs_login";
    case "error":
      return connector.flow === "api_key" &&
        connection.error?.code === "invalid_api_key"
        ? "invalid_key"
        : "needs_login";
    default:
      // Active, degraded (recovers by itself) and rate limited (the quota bar says until when).
      return "ok";
  }
}

function accountSource(
  connection: LlmConnection,
  connector: LlmConnector,
  models: readonly LlmModel[],
  quota: LlmQuota | undefined,
): AccountSource {
  return {
    type: "account",
    key: `account:${connection.id}`,
    name: connector.name,
    status: accountStatus(connection, connector),
    models: models.filter(
      (model) => model.connector === connector.id && model.available,
    ).length,
    connector,
    connection,
    quota,
  };
}

/**
 * Every source, accounts first (they need no setup beyond a sign-in), then the config's providers
 * in the order the file lists them. Undefined until the config has been read.
 */
export function useSources(): {
  sources: Source[] | undefined;
  error: Error | undefined;
} {
  const { data, error } = useProviders();
  const checks = useProviderChecks();
  const llm = useLlm();
  const sources = useMemo(() => {
    if (data === undefined) return undefined;
    const accounts = llm.connections.flatMap((connection) => {
      const connector = llm.connectors.find(
        (candidate) => candidate.id === connection.connector,
      );
      return connector === undefined
        ? []
        : [
            accountSource(
              connection,
              connector,
              llm.models,
              llm.quota.find((entry) => entry.connectionId === connection.id),
            ),
          ];
    });
    return [
      ...accounts,
      ...data.providers.map((provider) =>
        providerSource(provider, checks[provider.id]),
      ),
    ];
  }, [data, checks, llm.connections, llm.connectors, llm.models, llm.quota]);
  return { sources, error };
}
