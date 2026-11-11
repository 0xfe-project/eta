# Reading web pages and searching

Two product tools: `web_fetch` reads a web page and returns Markdown; `web_search` searches the web and returns ranked results. Both call libraries directly in the main node's process (`@searxng-js/sex-scrape`, `sex-search`, `sex-searxng`, `sex-page`, 0.1.1), without starting a separate service. The code is in `apps/eta/src/web/`.

## Why session tools

Like `open_pull_request`, these are tools that `sessionTools` hands to each session, not MCP servers:

- The libraries called are in the same process; no MCP client, port, or subprocess is needed to connect.
- Sessions on the daemon get them via `tool.call` (proxies for product tools, see [Machines and daemon](machines.md)); both scraping and search happen on the main node; the daemon does not need these libraries installed, and the single file produced by `bun build --compile` is unchanged.
- Reading web pages is a basic capability every agent should have, so it is available by default, just like the task and artifact tools.

## Switches and configuration

| Main node parameter   | Meaning                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| (Default)             | Both tools are present; `web_search` uses the main node-hosted SearXNG                                                  |
| `--searxng-url <url>` | Use an external SearXNG (the `json` format must be enabled). `ETA_SEARXNG_URL` is synonymous; the flag takes precedence |
| `--no-web`            | Neither tool is loaded                                                                                                  |

`startHost` does not load them by default (the host started by tests does not have these two tools); `main.ts` enables them, the same way as the LLM gateway.

## Why eta defines the parameters itself

The zod schema descriptions in sex-scrape / sex-search 0.1.1 are already neutrally worded, but the tools' parameters are still defined with eta's own TypeBox (descriptions borrow from sex-lite's MCP tools):

- The harness validates parameters with TypeBox (`defineTool`); sex's are zod, so a conversion is needed.
- sex's `ScrapeRequest` / `SearchRequest` are Firecrawl's full set of options: `formats`, `actions`, `waitFor`, `headers`, `maxAge`, `parsers`, `proxy`, `scrapeOptions`… most require a browser, LLM, or cache and would only return 501 in eta; things like `headers` and `timeout` should not be exposed to the model either. The less the model is shown, the fewer mistakes it makes, and the shorter the prompt.
- Things eta needs are absent from sex's schema: `web_fetch`'s `offset` (chunked reading), `web_search` uses the `timeRange` enum instead of Firecrawl's `tbs` string, and the upper limits for `limit` and `includeDomains` are smaller.

## web_fetch

- Parameters: `url`; `onlyMainContent` (default true, Defuddle extracts the main content; false is the full page); `offset` (the character in the Markdown to start from, default 0).
- Result: `Title:`, `URL:` (the address after redirects), the library-provided `Warning:`, then the Markdown.
- **Length**: at most 50KB per call (UTF-8 bytes, same as the `read` tool), breaking at newlines where possible and never splitting surrogate pairs. When not finished, the end states `[Showing characters A-B of N. Call web_fetch with the same url and offset=B for the next part.]`; the last part says `This is the end of the page.`
- **Continuation does not refetch**: fetched pages are kept in memory for 10 minutes (at most 16 pages). For `offset > 0`, this copy is used first to ensure all parts come from the same content; `offset` 0 always refetches.
- **SSRF**: sex-egress protections remain enabled: loopback, private networks, link-local (including `169.254.169.254`), and ULA are always rejected (`PRIVATE_NETWORK_BLOCKED`); after DNS validation the connection is pinned to the validated address, and every redirect hop is checked again. No configuration option can disable it; to read the local machine or an intranet, the agent uses bash.
- Maximum 10 MiB per page, 30 seconds by default; PDFs are also converted to Markdown (unpdf). Browser rendering and LLM formats are not supported.

## web_search

- Parameters: `query`; `limit` (number of results per source, 1–20, default 5); `sources` (`web`, `news`); `includeDomains` (at most 10, each one a separate query) or `excludeDomains`; `timeRange` (`day`, `week`, `month`, `year`); `lang`.
- Result: a numbered list, each entry with title, URL, and snippet; news is a separate section with dates; parameters SearXNG cannot handle are noted in `Warning:`.
- Do not fetch result pages along the way: the description tells the model to use `web_fetch` for the few URLs it needs, so context is spent only on pages it actually reads.

## SearXNG

- **External**: `--searxng-url`. The main node only queries it and does not manage its configuration.
- **Managed**: when no address is given, `sex-searxng` runs the prebuilt SearXNG from `@searxng-js/searxng` as a child process of the main node: it starts only on the first search (the first one takes a few extra seconds), listens only on loopback, and consecutive startup failures trigger a 30-second cooldown; it watches its own stdin pipe, so it exits when the main node exits (even if SIGKILLed), and `close()` stops it when the main node shuts down normally.
- **Platforms**: the prebuilt binaries are only linux-x64 (glibc ≥ 2.35), darwin-arm64, and win32-x64, installed as optional dependencies with `bun install`. Other platforms (linux-arm64, musl, Intel Mac) do not provide `web_search`; a warning is shown once at startup suggesting `--searxng-url`; `web_fetch` works as usual. The `oven/bun` image in `deploy/Dockerfile` is Debian (glibc 2.36), so managed mode works on x64; the arm64 image needs an external address.

## Proxy

eta's network setup (`initializeNetwork` in `@eta/server`) writes the proxy into environment variables. Scraping reads `HTTPS_PROXY` / `HTTP_PROXY` on each call and passes it to the library as `proxyUrl`; the managed SearXNG is created on the first search and receives the same proxy (written to its temporary settings.yml, mode 0600, deleted once it starts). When going through a proxy, requests can no longer be pinned to the validated address; the hostname is still resolved and validated first, and rebinding protection is left to the proxy.

## Runtime

These packages declare `node >= 24` in `engines`, while the repository root's `engines` is `node >= 22.12`. In practice they only run in the main node, which is always Bun (`bun apps/eta/src/main.ts`, the same for Docker and the desktop shell), and tests use `bun --bun vitest`; the daemon does not load them. So:

- No Node 24 required, and the root `engines` is not changed (that's for the toolchain running on Node, e.g. eslint, knip).
- On Bun, none of the library's optional peer dependencies are used: requests use Bun's `fetch` (not `undici`), Markdown to HTML uses `Bun.markdown` (not `marked`), and SearXNG's proxy config uses `Bun.YAML` (not `yaml`). So `apps/eta` does not declare them. To run the main node on Node in the future, these three must be added first.

## Errors and logging

- Library errors are `AppError` (imported from `@searxng-js/sex-scrape`); the main node's own rejections (offset out of bounds, no SearXNG) use it too, so tools have only one kind of failure to describe. Check with `AppError.isInstance(e)`, not `instanceof`: each published package bundles its own copy of this class. The model sees `CODE: message` (e.g. `PRIVATE_NETWORK_BLOCKED: ...`, `SEARCH_BACKEND_UNAVAILABLE: ...`) as a tool error.
- Cancellation and timeouts: tools pass the session's `AbortSignal` to the library. While `search()` waits for the managed SearXNG to start, it also watches this signal and the request's `timeout` (since sex-search 0.1.1); cancellation or timeout immediately yields `TIMEOUT` ("... while waiting for SearXNG to start"), SearXNG continues starting in the background, and the next search uses it directly.
- Logging: the library does not write to stdout/stderr itself; it publishes to `searxng-js:sex:{scrape,search,searxng,page}` on `node:diagnostics_channel`. The main node subscribes to these channels; `warn` and `error` go to the main node's `warn` (`[eta] web: <package>: <message> k=v`), while `debug` and `info` (every scrape, SearXNG's own output) are not logged.

## Testing

`apps/eta/test/web.test.ts`: scraping uses a loopback fixture site started by the test itself (`allowPrivateNetwork` is enabled only in tests, and verifies that it is rejected by default), search uses a fake SearXNG, plus one call through the scripted model to both tools in a real session. The two tests that access the external network and managed SearXNG are skipped by default and only run with `ETA_WEB_LIVE=1`.
