/**
 * A server that refuses an unsigned request with a body naming a header (Cursor-hosted servers):
 * the test result carries that header with no saved sign-in too. The fake records header names and
 * value lengths only; no value appears in any assertion.
 */
import { describe, expect, it } from "vitest";
import { testConnection } from "../src/plugins/test-server";

const CURSOR_URL = "https://api.cursor.com/rest-mcp/google-drive/mcp";
const NAMED =
  '{"error":"unauthorized","message":"Missing Cursor credential in x-cursor-auth"}';

function fake(bodies: string[]) {
  const seen: Record<string, number>[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const lengths: Record<string, number> = {};
    new Headers(init?.headers).forEach((value, name) => {
      lengths[name] = value.length;
    });
    seen.push(lengths);
    const body = bodies[Math.min(seen.length - 1, bodies.length - 1)]!;
    return new Response(body, { status: 401 });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const run = (url: string, bodies: string[]) => {
  const f = fake(bodies);
  return testConnection(
    {
      name: "remote",
      url,
      auth: "oauth",
      source: "plugin-test",
      hash: "plugin-test",
    } as never,
    [],
    5000,
    undefined,
    f.fetchImpl,
  ).then((result) => ({ result, seen: f.seen }));
};

describe("a 401 that names a header, with no saved sign-in", () => {
  it("returns the header, says Cursor first and the service second, and marks a Cursor server", async () => {
    const { result, seen } = await run(CURSOR_URL, [NAMED]);
    expect(result.status).toBe("needs_login");
    expect(result.requiredHeader).toBe("x-cursor-auth");
    expect(result.cursorServer).toBe(true);
    expect(result.message).toContain("Cursor account first");
    expect(result.message).toContain("then sign in to the service");
    // Nothing of ours was sent as the credential: no Authorization, no x-cursor-auth.
    for (const names of seen) {
      expect(Object.keys(names)).not.toContain("authorization");
      expect(Object.keys(names)).not.toContain("x-cursor-auth");
    }
  });

  it("does not mark a server that is not on cursor.com", async () => {
    const { result } = await run("https://example.com/mcp", [NAMED]);
    expect(result.requiredHeader).toBe("x-cursor-auth");
    expect(result.cursorServer).toBeUndefined();
  });

  it("carries no header for an ordinary 401 from a server that is not Cursor's", async () => {
    const { result } = await run("https://example.com/mcp", ["nope"]);
    expect(result.requiredHeader).toBeUndefined();
    expect(result.cursorServer).toBeUndefined();
  });

  it("does not depend on the 401 body: a Cursor server with no credential saved needs the Cursor sign-in", async () => {
    const body =
      '{"code":"unauthenticated","debug":{"error":"ERROR_NOT_LOGGED_IN"}}';
    const { result } = await run(CURSOR_URL, [body]);
    expect(result.status).toBe("needs_login");
    expect(result.requiredHeader).toBe("x-cursor-auth");
    expect(result.cursorServer).toBe(true);
    expect(result.message).toContain("sign in with your Cursor account first");
    expect(result.message).not.toContain("stored sign-in");
  });

  it("with the credential header saved, the same 401 is not answered with 'sign in with Cursor first'", async () => {
    const f = fake(['{"debug":{"error":"ERROR_NOT_LOGGED_IN"}}']);
    const result = await testConnection(
      {
        name: "remote",
        url: CURSOR_URL,
        auth: "oauth",
        headers: { "X-Cursor-Auth": "Bearer value-not-shown" },
        source: "plugin-test",
        hash: "plugin-test",
      } as never,
      ["Bearer value-not-shown"],
      5000,
      undefined,
      f.fetchImpl,
    );
    expect(result.message).not.toContain("Cursor account first");
    expect(JSON.stringify(result)).not.toContain("value-not-shown");
    expect(result.cursorServer).toBeUndefined();
  });

  it("keeps the header when a later 401 does not name one", async () => {
    const { result, seen } = await run(CURSOR_URL, [NAMED, "nope"]);
    expect(result.requiredHeader).toBe("x-cursor-auth");
    // How many 401s the SDK produced is its business; the answer holds for one or several.
    expect(seen.length).toBeGreaterThan(0);
  });
});
