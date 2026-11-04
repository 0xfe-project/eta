import type { SearchEntry } from "../src/search-ranking";
/**
 * Ranking, keywords, pagination, tool-name matching and suggestions.
 */
import { describe, expect, it } from "vitest";
import { findTools, isToolAllowed, matchesToolPattern } from "../src/names";
import {
  paginate,
  rankTools,
  resolveSearchKeywords,
  suggest,
} from "../src/search-ranking";

function entry(
  server: string,
  name: string,
  description = "",
  extra: Partial<SearchEntry> = {},
): SearchEntry {
  return { server, tool: { name, description }, ...extra };
}

const entries = [
  entry("fs", "read_file", "Read the contents of a file"),
  entry("fs", "write_file", "Write contents to a file"),
  entry("fs", "list_directory", "List the files in a directory"),
  entry("web", "fetch_url", "Download a web page", {
    serverDescription: "Browse the internet",
  }),
  entry("git", "git_status", "Show the working tree status"),
];

describe("rankTools", () => {
  it("puts a name match above a description match", () => {
    const ranked = rankTools(entries, "file");
    expect(ranked.map((match) => match.tool.name).slice(0, 2)).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(ranked.map((match) => match.tool.name)).toContain("list_directory");
  });

  it("matches words in any order and by stem", () => {
    expect(rankTools(entries, "file read")[0]?.tool.name).toBe("read_file");
    expect(rankTools(entries, "director")[0]?.tool.name).toBe("list_directory");
  });

  it("uses the server name and the server description", () => {
    expect(rankTools(entries, "web").map((match) => match.tool.name)).toContain(
      "fetch_url",
    );
    expect(rankTools(entries, "internet")[0]?.tool.name).toBe("fetch_url");
  });

  it("does not return tools that cover too little of a longer query", () => {
    expect(rankTools(entries, "read banana pear file")).toEqual([]);
    expect(rankTools(entries, "zzz")).toEqual([]);
    expect(rankTools(entries, "   ")).toEqual([]);
  });

  it("ranks by searchKeywords", () => {
    const withKeywords = [
      ...entries,
      entry("ops", "deploy_app", "Ship it", {
        keywords: ["release", "go live"],
      }),
    ];
    expect(rankTools(withKeywords, "release")[0]).toMatchObject({
      server: "ops",
      tool: { name: "deploy_app" },
    });
    expect(rankTools(withKeywords, "go live")[0]?.tool.name).toBe("deploy_app");
    // Keywords never leak into other tools.
    expect(rankTools(entries, "release")).toEqual([]);
  });

  it("finds CJK text through bigrams", () => {
    const cjk = [
      entry("a", "search", "搜索网页内容"),
      entry("a", "other", "打开文件"),
    ];
    expect(rankTools(cjk, "网页")[0]?.tool.name).toBe("search");
  });
});

describe("resolveSearchKeywords", () => {
  it("unions every entry whose key names the tool, by name or glob", () => {
    const map = {
      read_file: ["open"],
      "read_*": ["cat", "open"],
      "write_*": ["save"],
    };
    expect(resolveSearchKeywords(map, "fs", "read_file")).toEqual([
      "open",
      "cat",
    ]);
    expect(resolveSearchKeywords(map, "fs", "write_file")).toEqual(["save"]);
    expect(resolveSearchKeywords(map, "fs", "fetch")).toEqual([]);
    expect(resolveSearchKeywords(undefined, "fs", "read_file")).toEqual([]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 25 }, (_, index) => index);

  it("returns a page and where the next one starts", () => {
    expect(paginate(items, 0, 12)).toMatchObject({
      total: 25,
      hasMore: true,
      nextOffset: 12,
    });
    expect(paginate(items, 12, 12).items[0]).toBe(12);
    const last = paginate(items, 24, 12);
    expect(last).toMatchObject({
      items: [24],
      hasMore: false,
      nextOffset: null,
    });
  });

  it("clamps bad input", () => {
    expect(paginate(items, -5, 0).items).toEqual([0]);
    expect(paginate(items, Number.NaN, Number.NaN).items).toEqual([0]);
    expect(paginate(items, 100, 5)).toMatchObject({
      items: [],
      hasMore: false,
    });
  });
});

describe("tool name matching", () => {
  const tools = [
    { server: "fs", name: "read-file" },
    { server: "fs", name: "write_file" },
    { server: "docs", name: "read_file" },
    { server: "docs", name: "search" },
  ];

  it("prefers an exact name, then qualified, then hyphen/underscore folded", () => {
    expect(findTools("write_file", tools)).toEqual([
      { server: "fs", name: "write_file" },
    ]);
    expect(findTools("mcp__docs__read_file", tools)).toEqual([
      { server: "docs", name: "read_file" },
    ]);
    expect(findTools("fs_write_file", tools)).toEqual([
      { server: "fs", name: "write_file" },
    ]);
    // The model typed an underscore for a hyphen: the exact tool on the other server wins first.
    expect(findTools("read_file", tools)).toEqual([
      { server: "docs", name: "read_file" },
    ]);
    expect(findTools("read-file", tools)).toEqual([
      { server: "fs", name: "read-file" },
    ]);
    expect(findTools("mcp__fs__read_file", tools)).toEqual([
      { server: "fs", name: "read-file" },
    ]);
  });

  it("returns every hit at the best level, and none for a miss", () => {
    const both = [
      { server: "a", name: "ping" },
      { server: "b", name: "ping" },
    ];
    expect(findTools("ping", both)).toHaveLength(2);
    expect(findTools("nope", tools)).toEqual([]);
  });

  it("matches include, exclude and approve patterns by name, qualified name and glob", () => {
    expect(matchesToolPattern("fs", "read_file", ["read_*"])).toBe(true);
    expect(matchesToolPattern("fs", "read-file", ["read_file"])).toBe(true);
    expect(matchesToolPattern("fs", "x", ["mcp__fs__x"])).toBe(true);
    expect(matchesToolPattern("fs", "x", ["mcp__other__*"])).toBe(false);
    expect(matchesToolPattern("fs", "x", [])).toBe(false);
    expect(isToolAllowed("fs", "a", ["a", "b"], ["b"])).toBe(true);
    expect(isToolAllowed("fs", "b", ["a", "b"], ["b"])).toBe(false);
    expect(isToolAllowed("fs", "c", ["a", "b"], undefined)).toBe(false);
    expect(isToolAllowed("fs", "c", undefined, undefined)).toBe(true);
  });
});

describe("suggest", () => {
  it("offers close names for a typo, even from a qualified or prefixed name", () => {
    expect(suggest(entries, "read_fil", 3)[0]).toBe("read_file");
    expect(suggest(entries, "mcp__fs__write_fil", 3)[0]).toBe("write_file");
    expect(suggest(entries, "fs_list_dir", 3)[0]).toBe("list_directory");
    expect(suggest(entries, "zzzz", 3)).toEqual([]);
  });
});
