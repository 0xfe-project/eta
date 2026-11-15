import type {
  ProviderKind,
  ProviderLogoRequest,
  ProviderLogosResult,
} from "@eta/client-contracts";
import type { Source } from "@/queries/sources";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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

/**
 * Eta's own mark, for Eta Token Plan: models.dev has no entry for it. The blocks of
 * `public/Eta-Logo.svg` without its background, drawn as a mask like every other logo.
 */
const ETA_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="300 300 1400 1400"><path d="M300 300h350v1400H300zM650 650h700v350H650zM1350 300h350v350h-350zM1000 1000h350v700h-350zM1350 1350h350v350h-350z"/></svg>`;

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
    ...Object.entries(BUILTIN_PROVIDER_PRESETS)
      .filter(([kind]) => kind !== "eta")
      .map(([kind, preset]) => ({
        key: logoKey.kind(kind as ProviderKind),
        ...(kind === "openai-codex"
          ? { id: "openai" }
          : { baseUrl: preset.baseUrl }),
      })),
    ...(data?.providers ?? [])
      .filter((provider) => provider.kind !== "eta")
      .map((provider) => ({
        key: logoKey.provider(provider.id),
        ...(provider.kind === "openai-codex"
          ? { id: "openai" }
          : { baseUrl: provider.baseUrl }),
      })),
  ];
  // Eta's own sources draw Eta's mark; the host is not asked for it.
  const etaKeys = [
    logoKey.kind("eta"),
    ...(data?.providers ?? [])
      .filter((provider) => provider.kind === "eta")
      .map((provider) => logoKey.provider(provider.id)),
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
  const fetched = query.data ?? NONE;
  const etaList = etaKeys.join("\n");
  return useMemo(
    () => ({
      ...fetched,
      ...Object.fromEntries(
        etaList.split("\n").map((key) => [key, ETA_LOGO_SVG]),
      ),
    }),
    [fetched, etaList],
  );
}
