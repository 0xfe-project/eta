import type { KernelTool } from "@eta/core";
/**
 * Reading the web: `web_fetch` against a fixture site on loopback, `web_search` against a fake
 * SearXNG, and the two on an agent's session. Nothing here goes to the internet; the tests that
 * do (`ETA_WEB_LIVE=1`) are skipped otherwise.
 */
import type { Server } from "bun";
import { channel } from "node:diagnostics_channel";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sliceText, Web } from "../src/web/service";
import { pageText, webSessionTools } from "../src/web/tools";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const LONG = Array.from(
  { length: 200 },
  (_, i) =>
    `<p>Paragraph ${i} of the long page, with a few words to make it longer.</p>`,
).join("\n");

const PAGES: Record<string, string> = {
  "/article": `<!doctype html><html><head><title>The fixture article</title></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <main><article><h1>The fixture article</h1>
    <p>This is the <strong>main content</strong> of a page served by the test itself.</p>
    <p>It has a second paragraph, so the extractor has something to keep.</p>
    </article></main>
    <footer>Footer text that only the whole page has</footer></body></html>`,
  "/long": `<!doctype html><html><head><title>Long</title></head><body><article><h1>Long</h1>${LONG}</article></body></html>`,
  "/empty": `<!doctype html><html><head></head><body></body></html>`,
};

let site: Server<undefined>;
let siteUrl: string;
const hits: string[] = [];

/** What the fake SearXNG was asked, and what it answers. */
const asked: URLSearchParams[] = [];
let searxStatus = 200;
let searx: Server<undefined>;
let searxUrl: string;

beforeAll(() => {
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      hits.push(pathname);
      if (pathname === "/moved")
        return Response.redirect(`${siteUrl}/article`, 302);
      const page = PAGES[pathname];
      return page === undefined
        ? new Response("not here", { status: 404 })
        : new Response(page, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    },
  });
  siteUrl = `http://127.0.0.1:${site.port}`;
  searx = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/search")
        return new Response("no", { status: 404 });
      asked.push(url.searchParams);
      if (searxStatus !== 200)
        return new Response("down", { status: searxStatus });
      const news = url.searchParams.get("categories") === "news";
      const results = news
        ? [
            {
              url: "https://news.example.org/today",
              title: "Today's story",
              content: "What happened",
              publishedDate: "2026-10-28T10:00:00Z",
            },
          ]
        : [
            {
              url: "https://bun.sh/",
              title: "Bun",
              content: "A fast JavaScript runtime",
            },
            {
              url: "https://example.com/docs",
              title: "Docs",
              content: "Reference",
            },
            {
              url: "https://example.org/blog",
              title: "Blog",
              content: "Posts",
            },
          ];
      return Response.json({ results, unresponsive_engines: [] });
    },
  });
  searxUrl = `http://127.0.0.1:${searx.port}`;
});

const webs: Web[] = [];
afterEach(async () => {
  await Promise.all(webs.splice(0).map(async (web) => await web.close()));
  hits.length = 0;
  asked.length = 0;
  searxStatus = 200;
});

afterAll(async () => {
  await site.stop(true);
  await searx.stop(true);
});

function makeWeb(options: Partial<ConstructorParameters<typeof Web>[0]> = {}) {
  const warnings: string[] = [];
  const web = new Web({
    warn: (message) => warnings.push(message),
    ...options,
  });
  webs.push(web);
  return { web, warnings };
}

/** The tools as a session gets them, by name. */
function toolsOf(web: Web): Map<string, KernelTool> {
  const tools = webSessionTools(web)({ meta: {} } as never);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

async function run(tool: KernelTool | undefined, args: unknown) {
  if (tool === undefined) throw new Error("no such tool");
  const result = (await tool.execute(args, { turn: 1, toolCallId: "t1" })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return {
    text: result.content.map((block) => block.text).join(""),
    isError: result.isError === true,
  };
}

describe("web_fetch", () => {
  it("returns a page's main content as Markdown, with its title and address", async () => {
    const { web } = makeWeb({ allowPrivateNetwork: true });
    const { text, isError } = await run(toolsOf(web).get("web_fetch"), {
      url: `${siteUrl}/moved`,
    });
    expect(isError).toBe(false);
    expect(text).toContain("Title: The fixture article");
    // The address the page ended up at, after the redirect.
    expect(text).toContain(`URL: ${siteUrl}/article`);
    expect(text).toContain("**main content**");
    expect(text).not.toContain("Footer text");
    // Short enough to come whole: nothing about parts.
    expect(text).not.toContain("Showing characters");
  });

  it("returns the whole page when asked", async () => {
    const { web } = makeWeb({ allowPrivateNetwork: true });
    const { text } = await run(toolsOf(web).get("web_fetch"), {
      url: `${siteUrl}/article`,
      onlyMainContent: false,
    });
    expect(text).toContain("Footer text");
  });

  it("refuses loopback, private and metadata addresses by default", async () => {
    const { web } = makeWeb();
    const fetch = toolsOf(web).get("web_fetch");
    for (const url of [
      `${siteUrl}/article`,
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      const { text, isError } = await run(fetch, { url });
      expect(isError, url).toBe(true);
      expect(text, url).toMatch(/^PRIVATE_NETWORK_BLOCKED: /);
    }
    // Refused before a connection was made.
    expect(hits).toEqual([]);
  });

  it("cuts a long page into parts, says where the next starts, and reads on from its copy", async () => {
    const { web } = makeWeb({ allowPrivateNetwork: true, pageBytes: 2000 });
    const fetch = toolsOf(web).get("web_fetch");
    const first = await run(fetch, { url: `${siteUrl}/long` });
    const next = /offset=(\d+) for the next part/.exec(first.text);
    expect(next).not.toBeNull();
    expect(first.text).toMatch(/\[Showing characters 0-\d+ of \d+\./);
    expect(first.text).toContain("Paragraph 0 ");
    expect(first.text).not.toContain("Paragraph 199 ");

    // Every part, to the end, from one fetch of the page.
    let offset = Number(next![1]);
    let parts = 1;
    let last = first.text;
    while (true) {
      const part = await run(fetch, { url: `${siteUrl}/long`, offset });
      expect(part.isError).toBe(false);
      parts += 1;
      last = part.text;
      const more = /offset=(\d+) for the next part/.exec(part.text);
      if (more === null) break;
      expect(Number(more[1])).toBeGreaterThan(offset);
      offset = Number(more[1]);
    }
    expect(parts).toBeGreaterThan(2);
    expect(last).toContain("This is the end of the page.");
    expect(last).toContain("Paragraph 199 ");
    expect(hits.filter((path) => path === "/long")).toHaveLength(1);

    const past = await run(fetch, {
      url: `${siteUrl}/long`,
      offset: 10_000_000,
    });
    expect(past.isError).toBe(true);
    expect(past.text).toMatch(/^BAD_REQUEST: offset 10000000 is past the end/);
  });

  it("says so when a page has no text, and names a failed fetch", async () => {
    const { web } = makeWeb({ allowPrivateNetwork: true });
    const fetch = toolsOf(web).get("web_fetch");
    const empty = await run(fetch, { url: `${siteUrl}/empty` });
    expect(empty.text).toContain("(The page has no text content.)");
    const bad = await run(fetch, { url: "not a url" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^[A-Z_]+: /);
  });

  it("stops when the call is cancelled", async () => {
    const { web } = makeWeb({ allowPrivateNetwork: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      web.fetchPage(`${siteUrl}/article`, {}, controller.signal),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("sliceText", () => {
  it("stays within the bytes, ends at a line break when one is near, and never splits a pair", () => {
    const text = "line one\nline two\nline three\n";
    expect(sliceText(text, 0, 20)).toEqual({
      text: "line one\nline two\n",
      end: 18,
    });
    expect(sliceText(text, 18, 100)).toEqual({
      text: "line three\n",
      end: text.length,
    });
    // Three bytes each: two fit in seven.
    expect(sliceText("中文字", 0, 7)).toEqual({ text: "中文", end: 2 });
    const emoji = "😀😀";
    expect(sliceText(emoji, 0, 5)).toEqual({ text: "😀", end: 2 });
    // A budget smaller than one character still moves on.
    expect(sliceText(emoji, 0, 1).end).toBe(2);
  });

  it("is what the tool's footer counts in", () => {
    const text = pageText({
      title: undefined,
      url: "https://example.com/",
      warning: "a warning",
      markdown: "abc",
      start: 3,
      end: 6,
      total: 9,
    });
    expect(text).toContain("Warning: a warning");
    expect(text).toContain(
      "[Showing characters 3-6 of 9. Call web_fetch with the same url and offset=6",
    );
  });
});

describe("web_search", () => {
  it("asks SearXNG and lists the results", async () => {
    const { web } = makeWeb({ searxngUrl: `${searxUrl}/` });
    const { text, isError } = await run(toolsOf(web).get("web_search"), {
      query: "bun runtime",
      limit: 2,
      timeRange: "week",
      lang: "en",
    });
    expect(isError).toBe(false);
    expect(text).toBe(
      "1. Bun\n   https://bun.sh/\n   A fast JavaScript runtime\n\n" +
        "2. Docs\n   https://example.com/docs\n   Reference",
    );
    const params = asked[0]!;
    expect(params.get("q")).toBe("bun runtime");
    expect(params.get("format")).toBe("json");
    expect(params.get("time_range")).toBe("week");
    expect(params.get("language")).toBe("en");
  });

  it("lists news on their own, and keeps to the domains asked for", async () => {
    const { web } = makeWeb({ searxngUrl: searxUrl });
    const search = toolsOf(web).get("web_search");
    const news = await run(search, { query: "today", sources: ["news"] });
    expect(news.text).toContain("News:\n\n1. Today's story");
    expect(news.text).toContain("https://news.example.org/today");

    const only = await run(search, {
      query: "docs",
      includeDomains: ["example.com"],
    });
    expect(only.text).toContain("https://example.com/docs");
    expect(only.text).not.toContain("bun.sh");

    const both = await run(search, {
      query: "docs",
      includeDomains: ["example.com"],
      excludeDomains: ["bun.sh"],
    });
    expect(both.isError).toBe(true);
  });

  it("names a SearXNG that fails", async () => {
    searxStatus = 403;
    const { web } = makeWeb({ searxngUrl: searxUrl });
    const { text, isError } = await run(toolsOf(web).get("web_search"), {
      query: "x",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/^SEARCH_BACKEND_ERROR: SearXNG returned HTTP 403/);
  });

  it("is not offered where there is no SearXNG to run, and the host says so once", () => {
    const { web, warnings } = makeWeb({
      platform: { os: "linux", cpu: "arm64" },
    });
    expect(web.searchable).toBe(false);
    expect([...toolsOf(web).keys()]).toEqual(["web_fetch"]);
    expect(warnings).toEqual([expect.stringContaining("--searxng-url")]);

    const given = makeWeb({
      platform: { os: "linux", cpu: "arm64" },
      searxngUrl: searxUrl,
    });
    expect([...toolsOf(given.web).keys()]).toEqual(["web_fetch", "web_search"]);
  });
});

describe("the libraries' logs", () => {
  it("reach the host's warn for warnings and errors, and nothing else, until it closes", async () => {
    const { web, warnings } = makeWeb({ searxngUrl: searxUrl });
    const scrape = channel("searxng-js:sex:scrape");
    scrape.publish({ level: "debug", msg: "fetched" });
    scrape.publish({
      level: "warn",
      msg: "blocked",
      fields: { status: 403, url: "https://a/" },
    });
    channel("searxng-js:sex:searxng").publish({
      level: "error",
      msg: "keeps failing",
    });
    await web.close();
    scrape.publish({ level: "warn", msg: "after close" });
    expect(warnings).toEqual([
      "[eta] web: scrape: blocked status=403 url=https://a/",
      "[eta] web: searxng: keeps failing",
    ]);
  });
});

describe("on an agent's session", () => {
  it("are offered and run in the host, and a host without them offers neither", async () => {
    const results: string[] = [];
    const steps = [
      call("web_search", { query: "bun runtime", limit: 1 }),
      call("web_fetch", { url: `${siteUrl}/article` }),
    ];
    const { models, requests } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") results.push(request.last);
      return steps[results.length] ?? say("done");
    });
    const w = await world({
      models,
      tasks: { runs: false },
      web: { searxngUrl: searxUrl },
    });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "look it up");
    const reply = await w.settled(group.id, sent.replies[0]!.id);
    expect(reply.text).toBe("done");
    expect(requests[0]!.tools).toEqual(
      expect.arrayContaining(["web_fetch", "web_search"]),
    );
    expect(results[0]).toContain("https://bun.sh/");
    // The host's own guard: the fixture is on loopback, so the agent cannot read it.
    expect(results[1]).toMatch(/^PRIVATE_NETWORK_BLOCKED: /);

    const none = scriptedModels(() => say("ok"));
    const bare = await world({ models: none.models, tasks: { runs: false } });
    const bob = await bare.agent("Bob");
    const theirs = await bare.project({ stewardId: bob.id });
    const chat = await bare.group(theirs.id, [bob.id]);
    await bare.watch(chat.id);
    const hello = await bare.send(chat.id, "hi");
    await bare.settled(chat.id, hello.replies[0]!.id);
    expect(none.requests[0]!.tools).not.toContain("web_fetch");
    expect(none.requests[0]!.tools).not.toContain("web_search");
  });
});

// The internet, and the SearXNG the host runs itself: `ETA_WEB_LIVE=1 bun --bun vitest --run web`.
describe.skipIf(process.env.ETA_WEB_LIVE !== "1")("live", () => {
  it("fetches a public page", async () => {
    const { web } = makeWeb();
    const { text, isError } = await run(toolsOf(web).get("web_fetch"), {
      url: "https://example.com/",
    });
    expect(isError).toBe(false);
    expect(text).toContain("Example Domain");
  });

  it("searches with the managed SearXNG", { timeout: 120_000 }, async () => {
    const { web } = makeWeb();
    expect(web.searchable).toBe(true);
    const { text, isError } = await run(toolsOf(web).get("web_search"), {
      query: "bun javascript runtime",
    });
    expect(isError, text).toBe(false);
    expect(text).toMatch(/^1\. /);
  });
});
