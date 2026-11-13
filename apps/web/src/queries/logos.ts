import type {
  ProviderKind,
  ProviderLogoRequest,
  ProviderLogosResult,
} from "@eta/client-contracts";
import type { Source } from "@/queries/sources";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useLlm } from "@/queries/llm";
import { useProviders } from "@/queries/providers";

// Model source logos, as models.dev draws them. The host finds each source's models.dev entry (by
// the gateway connector's provider, or by the source's address) and fetches the SVG; the page
// only asks, over the wire, and draws a letter for anything that has none.

/** The models.dev provider behind each gateway connector. */
const CONNECTOR_LOGOS: Readonly<Record<string, string>> = {
  codex: "openai",
  xai: "xai",
  gemini: "google",
};

export const logoKey = {
  provider: (id: string) => `provider:${id}`,
  connector: (id: string) => `connector:${id}`,
  kind: (kind: ProviderKind) => `kind:${kind}`,
};

const NONE: Record<string, string> = {};

/** A listed source's logo, when there is one. */
export function logoOf(
  logos: Readonly<Record<string, string>>,
  source: Source,
): string | undefined {
  return logos[
    source.type === "account"
      ? logoKey.connector(source.connector.id)
      : logoKey.provider(source.provider.id)
  ];
}

/**
 * Every logo the page can show: the configured providers', the gateway connectors' and the
 * presets'. Asked once per set of sources; the host keeps what it fetched.
 */
export function useSourceLogos(): Record<string, string> {
  const { data } = useProviders();
  const llm = useLlm();
  const sources: ProviderLogoRequest[] = [
    ...llm.connectors.flatMap((connector) =>
      CONNECTOR_LOGOS[connector.id] === undefined
        ? []
        : [
            {
              key: logoKey.connector(connector.id),
              id: CONNECTOR_LOGOS[connector.id],
            },
          ],
    ),
    ...Object.entries(BUILTIN_PROVIDER_PRESETS).map(([kind, preset]) => ({
      key: logoKey.kind(kind as ProviderKind),
      ...(kind === "openai-codex"
        ? { id: "openai" }
        : { baseUrl: preset.baseUrl }),
    })),
    ...(data?.providers ?? []).map((provider) => ({
      key: logoKey.provider(provider.id),
      ...(provider.kind === "openai-codex"
        ? { id: "openai" }
        : { baseUrl: provider.baseUrl }),
    })),
  ];
  const query = useQuery({
    queryKey: ["wire", "providers", "logos", sources],
    enabled: data !== undefined,
    staleTime: Infinity,
    retry: false,
    // A source added or removed asks again; the logos already drawn stay meanwhile.
    placeholderData: (previous) => previous,
    queryFn: async () =>
      (
        await getWire().call<ProviderLogosResult>(
          "providers",
          "logos",
          {
            sources,
          },
          { timeoutMs: 60_000 },
        )
      ).logos,
  });
  return query.data ?? NONE;
}
