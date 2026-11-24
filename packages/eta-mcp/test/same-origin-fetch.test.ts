import { describe, expect, it } from "vitest";
import { sameOriginFetch } from "../src/server-manager";

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to } });

describe("sameOriginFetch", () => {
  it("refuses a redirect to another host, so headers never go there", async () => {
    const seen: string[] = [];
    const base = async (input: string | URL) => {
      seen.push(String(input));
      return redirect("https://evil.example/steal");
    };
    const fetchSafe = sameOriginFetch(base as never, "https://api.example.com");
    await expect(
      fetchSafe("https://api.example.com/mcp", {
        headers: { authorization: "Bearer x" },
      }),
    ).rejects.toThrow(/another host/);
    expect(seen).toEqual(["https://api.example.com/mcp"]);
  });

  it("follows a redirect inside the same origin, keeping the request", async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const base = async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers });
      return calls.length === 1
        ? redirect("/v2/mcp")
        : new Response("ok", { status: 200 });
    };
    const fetchSafe = sameOriginFetch(base as never, "https://api.example.com");
    const response = await fetchSafe("https://api.example.com/mcp", {
      headers: { authorization: "Bearer x" },
    });
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/mcp",
      "https://api.example.com/v2/mcp",
    ]);
    expect(calls[1]!.headers).toEqual({ authorization: "Bearer x" });
  });

  it("stops a redirect loop", async () => {
    const base = async () => redirect("/again");
    const fetchSafe = sameOriginFetch(base as never, "https://api.example.com");
    await expect(fetchSafe("https://api.example.com/x")).rejects.toThrow(
      /redirects/,
    );
  });
});
