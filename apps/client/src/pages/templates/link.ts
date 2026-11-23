import { platform, signal, UrlScheme } from "nsh";
import { templates } from "./catalog";

/**
 * The template a link names: `eta://template?id=<id>` (the desktop and phone apps), or a host's
 * page with `?template=<id>` (the web). Only an id of the bundled catalog: a link opens the
 * gallery on that template, and nothing is made until the reader presses Import.
 */
export function templateLinkId(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  let id: string | null = null;
  if (parsed.protocol === "eta:") {
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
    if (action === "template") id = parsed.searchParams.get("id");
  } else if (parsed.protocol === "http:" || parsed.protocol === "https:")
    id = parsed.searchParams.get("template");
  return id && templates.some((template) => template.id === id)
    ? id
    : undefined;
}

/** A template a link asked for, until the workspace opens the gallery on it. */
export const requestedTemplate = signal<string | undefined>(undefined);

/**
 * On the web, the template the page's address names (`?template=<id>`), taken out of the address
 * so that a reload does not open the gallery again. The apps get their links as `open` events.
 */
export function takeTemplateFromPage(): string | undefined {
  const current = UrlScheme.url();
  if (platform.os !== "web" || !current) return undefined;
  const url = new URL(current);
  if (!url.searchParams.has("template")) return undefined;
  url.searchParams.delete("template");
  UrlScheme.setUrl(url.href);
  return templateLinkId(current);
}
