import type { ProviderArgs } from "@eta/client-contracts";
import { describe, expect, it, vi } from "vitest";
import { publicModelMetadata } from "../src/providers/metadata";

const catalog = {
  openai: {
    id: "openai",
    models: {
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        limit: { context: 1047576, output: 32768 },
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        cost: { input: 2 },
      },
      other: { id: "other", name: "Not requested" },
    },
  },
};
const args: ProviderArgs["metadata"] = {
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  modelIds: ["gpt-4.1", "unknown"],
};

describe("public model metadata", () => {
  it("requests only the fixed public source without any credentials and returns requested exact IDs only", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(catalog));
    expect(
      await publicModelMetadata(
        {
          ...args,
          apiKey: "secret",
          headers: { Authorization: "private", "x-key": "private" },
        } as ProviderArgs["metadata"],
        send,
      ),
    ).toEqual({
      models: [
        {
          id: "gpt-4.1",
          name: "GPT-4.1",
          contextWindow: 1047576,
          input: ["text", "image"],
        },
      ],
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "https://models.dev/api.json",
      {
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });
  it.each([
    { kind: "openai-compatible", baseUrl: "https://proxy.example/v1" },
    { kind: "deepseek", baseUrl: "https://proxy.example/v1" },
    { kind: "deepseek", baseUrl: "https://api.openai.com/v1" },
    { kind: "unknown", baseUrl: "https://api.openai.com/v1" },
    { kind: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
    {
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1?key=secret",
    },
    {
      kind: "openai-compatible",
      baseUrl: "https://user:secret@api.openai.com/v1",
    },
  ])(
    "does not guess provider identity for $kind at $baseUrl",
    async (reference) => {
      const send = vi.fn<typeof fetch>();
      expect(
        await publicModelMetadata(
          { ...args, ...reference } as ProviderArgs["metadata"],
          send,
        ),
      ).toEqual({ models: [] });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["deepseek", "https://api.deepseek.com", "deepseek"],
    ["kimi-coding", "https://api.kimi.com/coding/v1", "kimi-code-plan-cn"],
    [
      "zai-coding-cn",
      "https://open.bigmodel.cn/api/coding/paas/v4",
      "zhipuai-coding-plan",
    ],
    ["zai", "https://api.z.ai/api/coding/paas/v4", "zai-coding-plan"],
  ])(
    "maps the explicit %s preset to %s (%s)",
    async (kind, baseUrl, providerId) => {
      const send = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          [providerId]: {
            id: providerId,
            models: { exact: { id: "exact", name: "Exact" } },
          },
        }),
      );
      expect(
        await publicModelMetadata(
          {
            kind,
            baseUrl: `${baseUrl}/`,
            modelIds: ["exact"],
          } as ProviderArgs["metadata"],
          send,
        ),
      ).toEqual({ models: [{ id: "exact", name: "Exact" }] });
    },
  );
  it("does not match aliases, case changes, prefixes or a missing provider", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(catalog));
    expect(
      await publicModelMetadata(
        { ...args, modelIds: ["GPT-4.1", "gpt-4.1-latest", "gpt-4"] },
        send,
      ),
    ).toEqual({ models: [] });
    expect(
      await publicModelMetadata(
        args,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
      ),
    ).toEqual({ models: [] });
  });
  it("reports HTTP, network and malformed responses rather than claiming no matches", async () => {
    await expect(
      publicModelMetadata(
        args,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("private upstream body", { status: 503 }),
          ),
      ),
    ).rejects.toThrow("Public model metadata HTTP 503");
    await expect(
      publicModelMetadata(
        args,
        vi.fn<typeof fetch>().mockRejectedValue(new Error("network offline")),
      ),
    ).rejects.toThrow("network offline");
    for (const body of [
      [],
      null,
      { openai: { id: "openai", models: [] } },
      { openai: { id: "openai", models: { "gpt-4.1": { id: "different" } } } },
    ])
      await expect(
        publicModelMetadata(
          args,
          vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
        ),
      ).rejects.toThrow("Invalid public model metadata");
    await expect(
      publicModelMetadata(
        args,
        vi.fn<typeof fetch>().mockResolvedValue(new Response("not json")),
      ),
    ).rejects.toThrow();
  });
});
