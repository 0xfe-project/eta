/**
 * Eta Token Plan: eta's own gateway, an OpenAI Chat Completions endpoint whose ids are other
 * makers' models (`claude-sonnet-5`).
 *
 * The gateway is a scripted stand-in with the real one's answers: `/models` refuses a wrong key
 * with the 401 body the real gateway sends, and `/chat/completions` streams. Nothing here reaches
 * eta.0xfe.tech or models.dev.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { BUILTIN_PROVIDER_PRESETS } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { catalogCompat } from "../src/providers/catalog";
import { checkOf, listProviderModels } from "../src/providers/discovery";
import {
  MODELS_DEV_URL,
  modelsDevByModelId,
  publicModelMetadata,
} from "../src/providers/metadata";
import { buildModels } from "../src/providers/runtime";

const GATEWAY = BUILTIN_PROVIDER_PRESETS.eta.baseUrl;
const KEY = "sk-eta-test";
const REFUSED = {
  error: { message: "invalid API key", type: "authentication_error" },
};

/** models.dev, cut down: the maker, a reseller with other limits, and the odd ones out. */
const MODELS_DEV = {
  "zz-reseller": {
    id: "zz-reseller",
    npm: "@ai-sdk/openai-compatible",
    api: "https://reseller.example/v1",
    models: {
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 (resold)",
        limit: { context: 200000, output: 8192 },
      },
      "kimi-k3": {
        id: "kimi-k3",
        name: "Kimi K3",
        reasoning: false,
        limit: { context: 262144, output: 32768 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        status: "beta",
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        limit: { context: 1000000, output: 64000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
    },
  },
  "aa-mirror": {
    id: "aa-mirror",
    models: {
      "kimi-k3": {
        id: "kimi-k3",
        name: "Kimi K3 (mirror)",
        limit: { context: 131072 },
      },
      "Glm-6": { id: "Glm-6", name: "GLM-6", limit: { context: 200000 } },
      broken: { id: "broken", limit: { context: -1 } },
    },
  },
  "bb-fallback": {
    id: "bb-fallback",
    models: {
      broken: { id: "broken", name: "Broken, listed right", reasoning: false },
    },
  },
  "not-a-provider": { id: "something-else", models: {} },
};

describe("models.dev by model id (Eta Token Plan)", () => {
  it("takes the maker's entry over a reseller's, with everything the model is", () => {
    expect(modelsDevByModelId(MODELS_DEV, ["claude-sonnet-5"])).toEqual([
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        contextWindow: 1000000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      },
    ]);
  });

  it("without a maker, takes the provider whose id sorts first", () => {
    expect(modelsDevByModelId(MODELS_DEV, ["kimi-k3"])).toEqual([
      { id: "kimi-k3", name: "Kimi K3 (mirror)", contextWindow: 131072 },
    ]);
  });

  it("compares without case only when no provider lists the id exactly", () => {
    expect(modelsDevByModelId(MODELS_DEV, ["glm-6"])).toEqual([
      { id: "glm-6", name: "GLM-6", contextWindow: 200000 },
    ]);
  });

  it("passes over an entry that does not parse, and leaves an unknown id empty", () => {
    expect(
      modelsDevByModelId(MODELS_DEV, ["broken", "nobody-lists-this"]),
    ).toEqual([
      { id: "broken", name: "Broken, listed right", reasoning: false },
    ]);
  });

  it("is what metadata answers for the preset, and only at the preset's address", async () => {
    const send = (async () =>
      Response.json(MODELS_DEV)) as unknown as typeof fetch;
    await expect(
      publicModelMetadata(
        { kind: "eta", baseUrl: `${GATEWAY}/`, modelIds: ["kimi-k3"] },
        send,
      ),
    ).resolves.toEqual({
      models: [
        { id: "kimi-k3", name: "Kimi K3 (mirror)", contextWindow: 131072 },
      ],
    });
    // A custom endpoint at another address is no gateway of eta's: nothing is guessed.
    for (const reference of [
      { kind: "eta", baseUrl: "https://proxy.example/v1" },
      { kind: "openai-compatible", baseUrl: "https://proxy.example/v1" },
    ] as const)
      await expect(
        publicModelMetadata({ ...reference, modelIds: ["kimi-k3"] }, send),
      ).resolves.toEqual({ models: [] });
  });
});

/** The gateway's `/models` and models.dev, as one fetch; every request is kept. */
function gatewayFetch(list: unknown[] = [{ id: "claude-sonnet-5" }]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const send = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url === MODELS_DEV_URL) return Response.json(MODELS_DEV);
    if (url !== `${GATEWAY}/models`) return new Response(null, { status: 404 });
    return headers.Authorization === `Bearer ${KEY}`
      ? Response.json({ object: "list", data: list })
      : Response.json(REFUSED, { status: 401 });
  }) as unknown as typeof fetch;
  return { send, calls };
}

describe("connecting Eta Token Plan", () => {
  const reference = { kind: "eta" as const, baseUrl: GATEWAY };

  it("lists the gateway's models with the key, and fills them in from models.dev", async () => {
    const { send, calls } = gatewayFetch([
      { id: "claude-sonnet-5", object: "model", owned_by: "eta" },
      { id: "nobody-lists-this", object: "model" },
    ]);
    const result = await listProviderModels({
      reference,
      apiKey: KEY,
      fetch: send,
    });
    expect(result.failure).toBeUndefined();
    expect(result.models).toEqual([
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        contextWindow: 1000000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      },
      { id: "nobody-lists-this" },
    ]);
    expect(calls[0]).toMatchObject({
      url: `${GATEWAY}/models`,
      headers: { Authorization: `Bearer ${KEY}` },
    });
    // models.dev is public: the key goes to the gateway only.
    const catalog = calls.find((call) => call.url === MODELS_DEV_URL);
    expect(JSON.stringify(catalog?.headers)).not.toContain(KEY);
  });

  it("calls a refused key an invalid key", async () => {
    const { send, calls } = gatewayFetch();
    const result = await listProviderModels({
      reference,
      apiKey: "sk-wrong",
      fetch: send,
    });
    expect(result).toMatchObject({ models: [], failure: "http", status: 401 });
    expect(checkOf(result)).toEqual({
      state: "invalid_key",
      error: "discovery_http_401",
    });
    // A refused key asks models.dev nothing.
    expect(calls.map((call) => call.url)).toEqual([`${GATEWAY}/models`]);
  });
});

describe("talking to Eta Token Plan", () => {
  it("turns off the fields the gateway is not sent", () => {
    expect(catalogCompat("eta")).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    });
    // pi-ai knows its own providers' fields; the catalog does not overrule it there.
    expect(catalogCompat("kimi-coding")).toBeUndefined();
    expect(catalogCompat("openai-compatible")).toBeUndefined();
  });

  it("streams, calls a tool, takes its result and answers, over Chat Completions", async () => {
    const bodies: Record<string, unknown>[] = [];
    const authorizations: (string | null)[] = [];
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        model: "claude-sonnet-5",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("authorization"));
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        const toolTurn = bodies.length === 1;
        const events = toolTurn
          ? [
              chunk({ role: "assistant", content: "" }),
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read", arguments: '{"path":' },
                  },
                ],
              }),
              chunk({
                tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
              }),
              chunk({}, "tool_calls"),
            ]
          : [
              chunk({ role: "assistant", content: "It says " }),
              chunk({ content: "hello." }),
              chunk({}, "stop"),
            ];
        return new Response(`${events.join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const { models } = await buildModels([
        {
          id: "eta-token-plan",
          name: "Eta Token Plan",
          kind: "eta",
          // The real address is the preset's; the stand-in is local.
          baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
          apiKey: KEY,
          models: [
            {
              id: "claude-sonnet-5",
              contextWindow: 1000000,
              maxTokens: 64000,
              reasoning: true,
              reasoningEfforts: ["low", "medium", "high"],
            },
          ],
        },
      ]);
      const model = models!.getModel("eta-token-plan", "claude-sonnet-5")!;
      const context: Context = {
        systemPrompt: "You are a test.",
        messages: [{ role: "user", content: "Read a.txt", timestamp: 0 }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            } as never,
          },
        ],
      };
      const events: string[] = [];
      const stream = models!.streamSimple(model, context, {
        reasoning: "high",
      });
      for await (const event of stream) events.push(event.type);
      const first: AssistantMessage = await stream.result();
      expect(first.stopReason).toBe("toolUse");
      expect(first.content).toEqual([
        expect.objectContaining({
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: "a.txt" },
        }),
      ]);
      expect(events).toContain("toolcall_delta");

      context.messages.push(first, {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "hello" }],
        isError: false,
        timestamp: 0,
      });
      const texts: string[] = [];
      const second = models!.streamSimple(model, context);
      for await (const event of second)
        if (event.type === "text_delta") texts.push(event.delta);
      expect(texts).toEqual(["It says ", "hello."]);
      expect((await second.result()).stopReason).toBe("stop");

      expect(authorizations).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
      const [ask, answer] = bodies;
      expect(ask).toMatchObject({
        model: "claude-sonnet-5",
        stream: true,
        reasoning_effort: "high",
        max_tokens: expect.any(Number),
        messages: [
          { role: "system", content: "You are a test." },
          { role: "user" },
        ],
      });
      expect(ask).not.toHaveProperty("store");
      expect(ask).not.toHaveProperty("max_completion_tokens");
      expect(
        (ask?.tools as { function: object }[])[0]?.function,
      ).not.toHaveProperty("strict");
      expect(answer?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "tool", tool_call_id: "call_1" }),
        ]),
      );
    } finally {
      await gateway.stop(true);
    }
  });
});
