import type { EtaModelConfig } from "@eta/client-contracts";
import type { Source, SourceStatus } from "@/queries/sources";
import { translate } from "@/lib/i18n";

// How a model source and its models are put in words: its status, how it connects, its context
// window, what a model can do.

const STATUS_KEYS = {
  ok: "ok",
  needs_key: "needsKey",
  invalid_key: "invalidKey",
  needs_login: "needsLogin",
  unreachable: "unreachable",
  disabled: "disabled",
} as const satisfies Record<SourceStatus, string>;

export function statusText(status: SourceStatus): string {
  return translate(`providers:status.${STATUS_KEYS[status]}`);
}

/** How a source is connected: a sign-in, a key, an endpoint of the person's own. */
export function viaText(source: Source): string {
  if (source.type === "account")
    return source.connector.flow === "api_key"
      ? translate("providers:via.key")
      : translate("providers:via.subscription");
  switch (source.via) {
    case "key":
      return translate("providers:via.key");
    case "local":
      return translate("providers:via.local");
    case "legacy":
      return translate("providers:via.legacy");
    case "custom":
      return translate("providers:via.custom", {
        protocol: protocolName(source.provider.kind),
      });
  }
}

/** The protocol a custom endpoint speaks, by the name its API documents it under. */
export function protocolName(kind: string): string {
  return kind === "openai-responses" ? "Responses" : "Chat Completions";
}

/** A context window the way the table reads it: 128K, 1M. */
export function formatContext(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Tags for what a model can do; nothing when nothing is known. */
export function abilityTags(model: EtaModelConfig): string[] {
  return [
    ...(model.reasoning === true
      ? [translate("providers:models.reasoning")]
      : []),
    ...(model.input?.includes("image") === true
      ? [translate("providers:models.vision")]
      : []),
  ];
}
