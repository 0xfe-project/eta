import { describe, expect, it } from "vitest";
import { attributionHeaders } from "../src/providers/attribution";
import { discoverModels } from "../src/providers/discovery";
import { buildModels, withSessionHeader } from "../src/providers/runtime";

describe("provider attribution", () => {
  it("scopes attribution and respects case-insensitive overrides and removal", () => {
    expect(attributionHeaders("https://openrouter.ai/api/v1")).toEqual({
      "User-Agent": "eta/dev",
      "HTTP-Referer": "https://github.com/0xfe-project/eta",
      "X-OpenRouter-Title": "Eta",
    });
    expect(attributionHeaders("https://openrouter.ai.example/v1")).toEqual({
      "User-Agent": "eta/dev",
    });
    expect(
      attributionHeaders("https://example.com", { "user-agent": "custom/1" }),
    ).toEqual({ "user-agent": "custom/1" });
    expect(
      attributionHeaders("https://example.com", { "USER-AGENT": null }),
    ).toEqual({});
  });
  it("sends identity for discovery and streaming alongside the session header", async () => {
    const received: {
      path: string;
      ua: string | null;
      session: string | null;
    }[] = [];
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          ua: request.headers.get("user-agent"),
          session: request.headers.get("x-opencode-session"),
        });
        if (request.method === "GET")
          return Response.json({ data: [{ id: "m1", context_window: 32000 }] });
        return Response.json(
          { error: { message: "captured" } },
          { status: 400 },
        );
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${endpoint.port}/v1`;
      await discoverModels({
        reference: { kind: "openai-compatible", baseUrl },
        apiKey: "test",
      });
      const { models } = await buildModels([
        {
          id: "test",
          kind: "opencode-go",
          baseUrl,
          apiKey: "test",
          models: [{ id: "m1" }],
        },
      ]);
      const scoped = withSessionHeader(models!, "eta-attribution-test");
      const model = scoped.getModel("test", "m1")!;
      const stream = scoped.streamSimple(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      });
      await stream.result();
      expect(received).toEqual([
        { path: "/v1/models", ua: "eta/dev", session: null },
        {
          path: "/v1/chat/completions",
          ua: "eta/dev",
          session: "eta-attribution-test",
        },
      ]);
    } finally {
      await endpoint.stop(true);
    }
  });
});
