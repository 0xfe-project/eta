import type { ProviderHeaders } from "@eta/client-contracts";
import { applyProviderHeaders, sanitizeProviderHeaders } from "./config-types";

declare const ETA_HOST_VERSION: string | undefined;

/** The host build defines this token; source runs identify themselves as dev. */
export const ETA_USER_AGENT = `eta/${typeof ETA_HOST_VERSION === "string" ? ETA_HOST_VERSION : "dev"}`;

/** Defaults shared by generation, discovery and connection checks. */
export function attributionHeaders(
  baseUrl: string,
  configured?: ProviderHeaders,
): Record<string, string> {
  const defaults: Record<string, string> = { "User-Agent": ETA_USER_AGENT };
  // Attribution is scoped to the official endpoint, never a look-alike or a custom proxy.
  if (new URL(baseUrl).origin === "https://openrouter.ai") {
    defaults["HTTP-Referer"] = "https://github.com/0xfe-project/eta";
    defaults["X-OpenRouter-Title"] = "Eta";
  }
  return applyProviderHeaders(defaults, sanitizeProviderHeaders(configured));
}
