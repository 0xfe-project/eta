import type { ComposioToolkit, MarketCatalog } from "@eta/client-contracts";
import { openMarket } from "./composio-market";

function toolkit(
  slug: string,
  name: string,
  authSchemes: string[],
  managed: boolean,
): ComposioToolkit {
  return {
    kind: "composio",
    slug,
    name,
    description: name + " toolkit",
    auth: "oauth",
    authSchemes,
    managed,
    categories: [],
    logo: null,
    appUrl: null,
    toolsCount: 3,
    source: "composio",
    sourceName: "Composio",
  };
}

const catalog: MarketCatalog = {
  proxy: "",
  sources: [
    {
      source: {
        url: "composio",
        name: "Composio",
        enabled: true,
        kind: "composio",
      },
      entries: [],
      rejected: [],
      error: null,
      status: "ready",
      toolkits: [
        toolkit("gmail", "Gmail", ["OAUTH2"], true),
        toolkit("twitter", "Twitter", ["OAUTH2"], false),
        toolkit("railway", "Railway", ["OAUTH2", "API_KEY"], false),
        toolkit("cloudflare_mcp", "Cloudflare MCP", ["DCR_OAUTH"], false),
      ],
    },
  ],
};
openMarket(catalog);
