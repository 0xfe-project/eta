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
});

describe("resolveServers", () => {
  it("lets a later source replace an earlier one's server as a whole", () => {
    const { servers, issues } = resolveServers([
      {
        name: "bundle",
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
    expect(servers.get("b")?.source).toBe("bundle");
    expect(issues).toEqual(['server "a": "user" overrides "bundle"']);
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
