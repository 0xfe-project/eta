import type { SearchEntry } from "../src/search-ranking";
/**
 * Ranking, keywords, pagination, tool-name matching and suggestions.
 */
import { describe, expect, it } from "vitest";
import { isToolAllowed, matchesToolPattern } from "../src/names";
import { rankTools, resolveSearchKeywords } from "../src/search-ranking";

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

describe("tool name matching", () => {
  it("matches include and exclude patterns by name, qualified name and glob", () => {
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
