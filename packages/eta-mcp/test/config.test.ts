/**
 * Config sources: parsing the standard shape, merging in order, and the hash that keys the cache.
 */
import { describe, expect, it } from "vitest";
import {
  computeServerHash,
  parseMcpServers,
  resolveServers,
} from "../src/config";

describe("parseMcpServers", () => {
  it("reads the standard mcpServers shape with the adapter fields", () => {
    const { servers, issues } = parseMcpServers({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "@scope/fs"],
          env: { ROOT: "/tmp" },
          lifecycle: "keep-alive",
          idleTimeout: 5,
          directTools: ["read_file"],
          searchKeywords: { read_file: ["open", "cat"] },
          approveTools: "destructive",
          includeTools: ["read_*"],
          excludeTools: ["read_secret"],
          description: "Files",
        },
        web: { url: "https://example.com/mcp", auth: "oauth", type: "http" },
      },
    });
    expect(issues).toEqual([]);
    expect(servers.fs).toMatchObject({
      command: "npx",
      lifecycle: "keep-alive",
      idleTimeout: 5,
      directTools: ["read_file"],
      searchKeywords: { read_file: ["open", "cat"] },
      approveTools: "destructive",
      includeTools: ["read_*"],
      excludeTools: ["read_secret"],
      description: "Files",
    });
    expect(servers.web).toMatchObject({
      url: "https://example.com/mcp",
      auth: "oauth",
      type: "http",
    });
  });

  it("accepts a bare map and reports entries that cannot work", () => {
    const { servers, issues } = parseMcpServers({
      ok: { command: "x" },
      empty: {},
      both: { command: "x", url: "https://x" },
      bad: { command: "x", lifecycle: "eager", idleTimeout: -1, args: "nope" },
    });
    expect(Object.keys(servers).sort()).toEqual(["bad", "ok"]);
    expect(servers.bad).toEqual({ command: "x" });
    expect(issues.join("\n")).toContain('needs a "command" or a "url"');
    expect(issues.join("\n")).toContain('both "command" and "url"');
    expect(issues.join("\n")).toContain('ignored malformed "lifecycle"');
    expect(issues.join("\n")).toContain('ignored malformed "args"');
  });

  /**
   * A file from 0.3.0, where `auth` and the override list did not exist yet (they came with the
   * plugin-server work). Nothing in it may be read as a claim about authorization: the settings
   * page asks for a login only for `auth: "oauth"` (`McpService#authOf`), so a server that says
   * nothing shows no button and connects as it always did.
   */
  it("reads a 0.3.0-shaped file as it did, without claiming anything about auth", () => {
    const { servers, issues } = parseMcpServers({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "@scope/fs"],
          env: { ROOT: "/tmp" },
        },
        remote: { url: "https://example.com/mcp" },
      },
    });
    expect(issues).toEqual([]);
    expect(servers.fs).toEqual({
      command: "npx",
      args: ["-y", "@scope/fs"],
      env: { ROOT: "/tmp" },
    });
    expect(servers.remote).toEqual({ url: "https://example.com/mcp" });
    expect(servers.remote?.auth).toBeUndefined();
    // An `auth` a hand-edit made up is dropped, not guessed at.
    expect(
      parseMcpServers({
        mcpServers: { odd: { url: "https://x", auth: "oauth2" } },
      }).servers.odd?.auth,
    ).toBeUndefined();
  });
});

describe("resolveServers", () => {
  it("lets a later source replace an earlier one's server as a whole", () => {
    const { servers, issues } = resolveServers([
      {
        name: "base",
        servers: {
          a: { command: "one", lifecycle: "keep-alive" },
          b: { command: "b" },
        },
      },
      { name: "user", servers: { a: { command: "two" } } },
      { name: "project", servers: { c: { url: "https://c" } } },
    ]);
    expect([...servers.keys()]).toEqual(["a", "b", "c"]);
    expect(servers.get("a")).toMatchObject({ command: "two", source: "user" });
    // Nothing of the replaced entry survives.
    expect(servers.get("a")?.lifecycle).toBeUndefined();
    expect(servers.get("b")?.source).toBe("base");
    expect(issues).toEqual(['server "a": "user" overrides "base"']);
  });

  it("lists what was replaced, with the source that won in the end", () => {
    const { servers, overridden } = resolveServers([
      {
        name: "plugin:p",
        servers: {
          "p-a": {
            url: "https://plugin",
            auth: "oauth",
            headers: { "x-plugin": "1" },
          },
        },
      },
      { name: "~/.eta/mcp.json", servers: { "p-a": { url: "https://user" } } },
      { name: ".mcp.json", servers: { "p-a": { command: "local" } } },
    ]);
    // Replaced whole: none of the plugin's url, headers or auth reach the winner.
    expect(servers.get("p-a")).toMatchObject({
      command: "local",
      source: ".mcp.json",
    });
    expect(servers.get("p-a")?.url).toBeUndefined();
    expect(servers.get("p-a")?.headers).toBeUndefined();
    expect(servers.get("p-a")?.auth).toBeUndefined();
    expect(
      overridden.map(({ definition, by }) => [definition.source, by]),
    ).toEqual([
      ["plugin:p", ".mcp.json"],
      ["~/.eta/mcp.json", ".mcp.json"],
    ]);
    expect(overridden[0]?.definition.url).toBe("https://plugin");
  });
});

describe("computeServerHash", () => {
  const base = { command: "node", args: ["server.js"], env: { A: "1" } };

  it("changes with what decides the server's tools", () => {
    const hash = computeServerHash(base);
    expect(computeServerHash({ ...base, args: ["other.js"] })).not.toBe(hash);
    expect(computeServerHash({ ...base, env: { A: "2" } })).not.toBe(hash);
    expect(computeServerHash({ ...base, includeTools: ["a"] })).not.toBe(hash);
    expect(computeServerHash({ ...base, excludeTools: ["a"] })).not.toBe(hash);
    expect(computeServerHash({ ...base, cwd: "/x" })).not.toBe(hash);
    expect(computeServerHash({ url: "https://a" })).not.toBe(
      computeServerHash({ url: "https://b" }),
    );
    expect(
      computeServerHash({ url: "https://a", headers: { x: "1" } }),
    ).not.toBe(computeServerHash({ url: "https://a" }));
  });

  it("ignores runtime behaviour and the order of keys", () => {
    const hash = computeServerHash(base);
    expect(
      computeServerHash({
        ...base,
        lifecycle: "keep-alive",
        idleTimeout: 1,
        requestTimeoutMs: 5,
        directTools: true,
        searchKeywords: { a: ["b"] },
        approveTools: true,
        description: "x",
      }),
    ).toBe(hash);
    expect(
      computeServerHash({
        env: { A: "1" },
        args: ["server.js"],
        command: "node",
      }),
    ).toBe(hash);
  });

  // eslint-disable-next-line no-template-curly-in-string -- the library interpolates these
  it("hashes what ${VAR} resolves to", () => {
    // eslint-disable-next-line no-template-curly-in-string -- the library interpolates this
    const entry = { command: "node", env: { TOKEN: "${T}" } };
    expect(computeServerHash(entry, { T: "one" })).not.toBe(
      computeServerHash(entry, { T: "two" }),
    );
    expect(computeServerHash(entry, { T: "one" })).toBe(
      computeServerHash(entry, { T: "one" }),
    );
  });
});
