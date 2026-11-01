/**
 * `web_fetch` and `web_search`: the web, read by the host for every session. They are session
 * tools like the GitHub ones, not an MCP server: what they call is a library in this process, so
 * no client, port or child of ours is needed to reach it, and a daemon's session gets them over
 * `tool.call` with the fetch made here.
 *
 * What a model reads is the description and the result. A page comes back as Markdown, a part of
 * it at a time (the same 50KB budget a file read has), with a line that says where the rest
 * starts; a search comes back as a short numbered list. The parameters are the ones of sex-lite's
 * MCP tools that make sense without a browser or an LLM behind them.
 */
import type { KernelTool } from "@eta/core";
import type { SearchData, SearchRequest } from "@searxng-js/sex-search";
import type { SessionHooks } from "../session-hooks";
import type { PageSlice, Web } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { AppError } from "@searxng-js/sex-scrape";
import { Type } from "typebox";

/**
 * A failure as the model reads it: the library's code, then what happened. `isInstance` rather
 * than `instanceof`, because every published sex package bundles its own copy of the class.
 */
const failure = (error: unknown) =>
  toolError(
    AppError.isInstance(error)
      ? `${error.code}: ${error.message}`
      : `INTERNAL_ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );

export function webSessionTools(
  web: Web,
): NonNullable<SessionHooks["sessionTools"]> {
  const tools = webTools(web);
  return () => tools;
}

function webTools(web: Web): KernelTool[] {
  const fetch = defineTool({
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch one URL and return its main content as Markdown. Long pages come back in parts: " +
      "the result ends with the offset to call again with for the next part. Set " +
      "onlyMainContent:false for the whole page (navigation, footers). Only public addresses can " +
      "be fetched; for localhost or a private network use bash.",
    parameters: Type.Object({
      url: Type.String({ description: "http or https URL" }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: "Return only the main content. Defaults to true.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Character offset into the page's Markdown to start from, as given at the end of the previous part. Defaults to 0.",
        }),
      ),
    }),
    async execute(args, { call }) {
      try {
        const page = await web.fetchPage(
          args.url,
          { onlyMainContent: args.onlyMainContent, offset: args.offset ?? 0 },
          call.signal,
        );
        return text(pageText(page), {
          url: page.url,
          start: page.start,
          end: page.end,
          total: page.total,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const search = defineTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Returns ranked results (title, URL, snippet). Use web_fetch on the few " +
      "URLs you need to read.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "Results per source. Defaults to 5.",
        }),
      ),
      sources: Type.Optional(
        Type.Array(Type.Union([Type.Literal("web"), Type.Literal("news")]), {
          description: 'Defaults to ["web"].',
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 10,
          description: "Only results from these domains (at most 10).",
        }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 50,
          description: "No results from these domains.",
        }),
      ),
      timeRange: Type.Optional(
        Type.Union(
          [
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year"),
          ],
          {
            description: "Only results from the last day, week, month or year.",
          },
        ),
      ),
      lang: Type.Optional(
        Type.String({ description: "Language code, e.g. en, zh-CN." }),
      ),
    }),
    async execute(args, { call }) {
      if (
        (args.includeDomains?.length ?? 0) > 0 &&
        (args.excludeDomains?.length ?? 0) > 0
      )
        return toolError(
          "BAD_REQUEST: includeDomains and excludeDomains cannot both be given",
        );
      const request: SearchRequest = {
        query: args.query,
        limit: args.limit ?? 5,
        ...(args.sources === undefined ? {} : { sources: args.sources }),
        ...(args.includeDomains === undefined
          ? {}
          : { includeDomains: args.includeDomains }),
        ...(args.excludeDomains === undefined
          ? {}
          : { excludeDomains: args.excludeDomains }),
        ...(args.timeRange === undefined
          ? {}
          : { tbs: `qdr:${args.timeRange[0]}` }),
        ...(args.lang === undefined ? {} : { lang: args.lang }),
      };
      try {
        const { data, warning } = await web.search(request, call.signal);
        return text(searchText(data, warning), {
          results: (data.web?.length ?? 0) + (data.news?.length ?? 0),
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  // These tools call the web, not files: they need no execution environment.
  const none = (): undefined => undefined;
  // Without a SearXNG to ask there is no search to offer: the model is not shown a tool that
  // can only fail.
  return (
    web.searchable
      ? [toKernelTool(fetch, none), toKernelTool(search, none)]
      : [toKernelTool(fetch, none)]
  ) as KernelTool[];
}

/** A header, the part of the page, and what to do about the rest. */
export function pageText(page: PageSlice): string {
  const lines = [`URL: ${page.url}`];
  if (page.title !== undefined) lines.unshift(`Title: ${page.title}`);
  if (page.warning !== undefined) lines.push(`Warning: ${page.warning}`);
  const head = lines.join("\n");
  if (page.markdown.trim() === "" && page.start === 0)
    return `${head}\n\n(The page has no text content.)`;
  const body = `${head}\n\n${page.markdown}`;
  if (page.start === 0 && page.end >= page.total) return body;
  const shown = `[Showing characters ${page.start}-${page.end} of ${page.total}.`;
  return page.end >= page.total
    ? `${body}\n\n${shown} This is the end of the page.]`
    : `${body}\n\n${shown} Call web_fetch with the same url and offset=${page.end} for the next part.]`;
}

/** A numbered list per source, and what SearXNG said it could not do. */
function searchText(data: SearchData, warning: string | undefined): string {
  const parts: string[] = [];
  const web = data.web ?? [];
  const news = data.news ?? [];
  if (web.length > 0)
    parts.push(
      web
        .map((result, i) =>
          entry(i + 1, result.title, result.url, result.description),
        )
        .join("\n\n"),
    );
  if (news.length > 0)
    parts.push(
      `News:\n\n${news
        .map((result, i) =>
          entry(
            i + 1,
            result.title,
            result.url,
            [result.date, result.snippet].filter(Boolean).join(" — "),
          ),
        )
        .join("\n\n")}`,
    );
  if (parts.length === 0) parts.push("No results.");
  if (warning !== undefined && warning !== "")
    parts.push(`Warning: ${warning}`);
  return parts.join("\n\n");
}

function entry(
  n: number,
  title: string | undefined,
  url: string | undefined,
  snippet: string | undefined,
): string {
  const lines = [
    `${n}. ${title === undefined || title === "" ? "(untitled)" : title}`,
  ];
  if (url !== undefined) lines.push(`   ${url}`);
  if (snippet !== undefined && snippet !== "") lines.push(`   ${snippet}`);
  return lines.join("\n");
}
