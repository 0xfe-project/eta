import { describe, expect, it, vi } from "vitest";
import { ProviderLogos } from "../src/providers/logos";
import { MODELS_DEV_URL } from "../src/providers/metadata";

const svg = (name: string) =>
  `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0"/><title>${name}</title></svg>`;

const catalog = {
  openrouter: {
    id: "openrouter",
    api: "https://openrouter.ai/api/v1/",
    models: {},
  },
  lmstudio: { id: "lmstudio", api: "http://127.0.0.1:1234/v1", models: {} },
  deepseek: { id: "deepseek", api: "https://api.deepseek.com", models: {} },
};

function models(overrides: Record<string, () => Response> = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    // Public data: nothing of the user's rides along.
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    if (url === MODELS_DEV_URL) return Response.json(catalog);
    const id = /\/logos\/([^/]+)\.svg$/.exec(url)?.[1];
    if (id !== undefined && overrides[id] !== undefined) return overrides[id]();
    if (id !== undefined)
      return new Response(svg(id), {
        headers: { "content-type": "image/svg+xml" },
      });
    return new Response("not found", { status: 404 });
  });
}

describe("provider logos from models.dev", () => {
  it("finds an entry by id, by official endpoint, or by the address its catalog entry declares", async () => {
    const send = models();
    const { logos } = await new ProviderLogos(send).logos([
      { key: "connector:codex", id: "openai" },
      { key: "preset:kimi", baseUrl: "https://api.kimi.com/coding/v1" },
      { key: "provider:router", baseUrl: "https://openrouter.ai/api/v1" },
      { key: "provider:lms", baseUrl: "http://127.0.0.1:1234/v1/" },
      // Nothing in the catalog lives here: the page draws a letter.
      { key: "provider:ollama", baseUrl: "http://127.0.0.1:11434/v1" },
      { key: "bad", id: "../etc/passwd" },
    ]);
    expect(Object.keys(logos).sort()).toEqual([
      "connector:codex",
      "preset:kimi",
      "provider:lms",
      "provider:router",
    ]);
    expect(logos["preset:kimi"]).toContain("kimi-code-plan-cn");
    expect(logos["provider:router"]).toContain("openrouter");
  });

  it("keeps what it fetched, and refuses what is not a small SVG", async () => {
    const send = models({
      big: () =>
        new Response(`<svg>${"x".repeat(70_000)}</svg>`, {
          headers: { "content-type": "image/svg+xml" },
        }),
      html: () =>
        new Response("<html><script>alert(1)</script></html>", {
          headers: { "content-type": "text/html" },
        }),
      gone: () => new Response("nope", { status: 404 }),
    });
    const logos = new ProviderLogos(send);
    const first = await logos.logos([
      { key: "a", id: "openai" },
      { key: "b", id: "big" },
      { key: "c", id: "html" },
      { key: "d", id: "gone" },
    ]);
    expect(Object.keys(first.logos)).toEqual(["a"]);
    send.mockClear();
    const again = await logos.logos([
      { key: "a", id: "openai" },
      { key: "d", id: "gone" },
    ]);
    expect(again.logos.a).toBe(first.logos.a);
    // Both answers, the logo and the miss, came from memory.
    expect(send).not.toHaveBeenCalled();
  });

  it("answers with no logos when models.dev cannot be reached", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(
      await new ProviderLogos(send).logos([
        { key: "a", id: "openai" },
        { key: "b", baseUrl: "https://openrouter.ai/api/v1" },
      ]),
    ).toEqual({ logos: {} });
  });
});
