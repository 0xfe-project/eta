import type {
  LlmAccounts,
  ProviderKind,
  ProviderLogoRequest,
  ProviderLogosResult,
  ProvidersView,
} from "@eta/client-contracts";
import { MODEL_SOURCES, modelSource } from "@eta/client-contracts";
import { effect, signal, untracked } from "nsh";
import { useHost } from "../../../services/host";

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
  /** The add-source dialog's "Local models": Ollama's mark (models.dev keeps it under `ollama-cloud`). */
  local: "local",
};

/** Eta's own mark, for Eta Token Plan: models.dev has no entry for it. */
const ETA_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="300 300 1400 1400"><path d="M300 300h350v1400H300zM650 650h700v350H650zM1350 300h350v350h-350zM1000 1000h350v700h-350zM1350 1350h350v350h-350z"/></svg>`;

/** How the host finds a source's logo: its kind's own, else by its address. */
function logoOfKind(
  kind: ProviderKind,
  baseUrl: string,
): Pick<ProviderLogoRequest, "id" | "baseUrl"> {
  const logo = modelSource(kind)?.logo;
  return logo === undefined ? { baseUrl } : { id: logo };
}

// What the host answered, kept for the session so a pane opened again draws its logos at once.
const fetched = signal<Record<string, string>>({});
let asked = "";
let askedHost = "";

/**
 * Every logo the settings can show: the configured providers', the gateway connectors' and the
 * presets'. Asked again only when the set of sources (or the host) changes.
 */
export function useSourceLogos(): (key: string) => string | undefined {
  const host = useHost();
  effect(() => {
    if (!host.can("providers.logos")) return;
    const providers =
      host.section<ProvidersView>("providers", "config")?.providers ?? [];
    const connectors =
      host.section<LlmAccounts>("llm", "accounts")?.connectors ?? [];
    const sources: ProviderLogoRequest[] = [
      ...connectors.flatMap((connector) =>
        CONNECTOR_LOGOS[connector.id] === undefined
          ? []
          : [
              {
                key: logoKey.connector(connector.id),
                id: CONNECTOR_LOGOS[connector.id],
              },
            ],
      ),
      { key: logoKey.local, id: "ollama-cloud" },
      ...(Object.keys(MODEL_SOURCES) as ProviderKind[])
        .filter((kind) => kind !== "eta" && modelSource(kind)?.baseUrl)
        .map((kind) => ({
          key: logoKey.kind(kind),
          ...logoOfKind(kind, modelSource(kind)?.baseUrl ?? ""),
        })),
      ...providers
        .filter((provider) => provider.kind !== "eta")
        .map((provider) => ({
          key: logoKey.provider(provider.id),
          ...logoOfKind(provider.kind, provider.baseUrl),
        })),
    ];
    const address = JSON.stringify(host.address());
    const request = JSON.stringify(sources);
    if (address !== askedHost) {
      askedHost = address;
      asked = "";
      fetched.set({});
    }
    if (request === asked) return;
    asked = request;
    void host
      .call<ProviderLogosResult>("providers", "logos", { sources })
      .then((result) => {
        if (asked === request && askedHost === address)
          fetched.set({ ...untracked(fetched), ...result.logos });
      })
      // No logo is no loss: the tiles keep their letters, and the next pane asks again.
      .catch(() => {
        if (asked === request && askedHost === address) asked = "";
      });
  });
  return (key) => {
    if (key === logoKey.kind("eta")) return ETA_LOGO_SVG;
    if (key.startsWith("provider:")) {
      const id = key.slice("provider:".length);
      const provider = host
        .section<ProvidersView>("providers", "config")
        ?.providers.find((entry) => entry.id === id);
      if (provider?.kind === "eta") return ETA_LOGO_SVG;
    }
    return fetched()[key];
  };
}

/**
 * A one-colour models.dev logo as an image drawn in `color`: its `currentColor` and its default
 * fill both become the colour, so it follows the theme like the letter it replaces.
 */
export function tintedLogo(svg: string, color: string): string {
  const drawn = svg
    .replaceAll("currentColor", color)
    .replace(/<svg\b([^>]*)>/, (tag, attributes: string) =>
      /\sfill\s*=/.test(attributes)
        ? tag
        : `<svg fill="${color}"${attributes}>`,
    );
  return `data:image/svg+xml,${encodeURIComponent(drawn)}`;
}
