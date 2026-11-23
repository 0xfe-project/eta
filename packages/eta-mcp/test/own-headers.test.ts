import { describe, expect, it } from "vitest";
import { ownHeadersOnly } from "../src/server-manager";

describe("ownHeadersOnly", () => {
  it("keeps the server's headers on its own origin and takes them off any other", async () => {
    const seen: [string, string[]][] = [];
    const base = (async (input: unknown, init?: RequestInit) => {
      seen.push([String(input), [...new Headers(init?.headers).keys()]]);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const guarded = ownHeadersOnly(base, "https://api.example.com", [
      "X-Cursor-Auth",
    ]);
    const headers = { "x-cursor-auth": "v", accept: "application/json" };
    await guarded("https://api.example.com/mcp", { headers });
    await guarded("https://oauth.other.test/token", { headers });
    expect(seen[0]?.[1]).toContain("x-cursor-auth");
    expect(seen[1]?.[1]).not.toContain("x-cursor-auth");
    expect(seen[1]?.[1]).toContain("accept");
  });

  it("still sends a static Authorization header on the server's own origin, and only there", async () => {
    // The fake records header names and value lengths, never values.
    const seen: [string, Record<string, number>][] = [];
    const base = (async (input: unknown, init?: RequestInit) => {
      const lengths: Record<string, number> = {};
      new Headers(init?.headers).forEach((value, name) => {
        lengths[name] = value.length;
      });
      seen.push([String(input), lengths]);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const guarded = ownHeadersOnly(base, "https://api.example.com", [
      "Authorization",
      "X-Cursor-Auth",
    ]);
    const headers = {
      authorization: "Bearer static-token-123",
      "x-cursor-auth": "Bearer jwt-456",
    };
    await guarded("https://api.example.com/mcp", { headers });
    await guarded("https://accounts.other.test/token", { headers });
    expect(seen[0]?.[1]).toEqual({ authorization: 23, "x-cursor-auth": 14 });
    expect(seen[1]?.[1]).toEqual({});
  });
});
