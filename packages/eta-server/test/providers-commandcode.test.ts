/**
 * Command Code: a provider whose model list is its models.dev entry (`commandcode`), and whose
 * one key serves Chat Completions, Responses and Anthropic Messages at the same address.
 *
 * `fixtures/models-dev-commandcode.json` is the `commandcode` entry of
 * https://models.dev/api.json as of 2026-11-16, trimmed to the fields eta reads. Its Claude models
 * are marked `@ai-sdk/anthropic` (Messages only), which eta does not speak yet: they are listed as
 * unsupported for that reason, never dropped and never sent over Chat Completions. Counts are read
 * from the fixture rather than written down, since the catalog grows.
 *
 * Nothing here reaches commandcode.ai or models.dev.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { MODEL_SOURCES } from "@eta/client-contracts";
import { describe, expect, it, vi } from "vitest";
import { catalogCompat } from "../src/providers/catalog";
import { providerSummary } from "../src/providers/config-types";
import { discoverModels, listProviderModels } from "../src/providers/discovery";
import { officialModelsDevId } from "../src/providers/metadata";
import { buildModels } from "../src/providers/runtime";
import snapshot from "./fixtures/models-dev-commandcode.json";

const COMMAND_CODE = {
  kind: "commandcode" as const,
  baseUrl: MODEL_SOURCES.commandcode.baseUrl,
};

const listed = snapshot.commandcode.models as Record<
  string,
  { name?: string; provider?: { npm?: string } }
>;
const anthropic = Object.keys(listed).filter(
  (id) => listed[id]?.provider?.npm === "@ai-sdk/anthropic",
);

function serving(body: unknown) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(body));
}

describe("the Command Code preset", () => {
  it("is called Command Code and points at the address models.dev lists", () => {
    expect(MODEL_SOURCES.commandcode).toMatchObject({
      name: "Command Code",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    });
    expect(COMMAND_CODE.baseUrl).toBe(snapshot.commandcode.api);
    expect(officialModelsDevId(COMMAND_CODE.baseUrl)).toBe("commandcode");
  });

  it("lists its models from models.dev and speaks Chat Completions, without OpenAI-only fields", () => {
    expect(MODEL_SOURCES.commandcode).toMatchObject({
      auth: "key",
      models: "models-dev",
      modelsDev: "commandcode",
    });
    expect(catalogCompat("commandcode")).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    });
  });

  it("is summarised as missing its key until one is saved", () => {
    expect(
      providerSummary({ id: "command-code", ...COMMAND_CODE, models: [] }),
    ).toMatchObject({ kind: "commandcode", hasApiKey: false });
  });
});

describe("discovering Command Code models", () => {
  it("offers the rest over Chat Completions and lists the Claude models as unsupported by protocol", async () => {
    const send = serving(snapshot);
    const found = await discoverModels({
      reference: COMMAND_CODE,
      apiKey: "sk-secret",
      fetch: send,
    });
    expect(found.error).toBeUndefined();
    expect(anthropic.length).toBeGreaterThan(0);
    expect(
      found.models.every((model) => model.api === "openai-completions"),
    ).toBe(true);
    expect(found.models.some((model) => model.id === "gpt-5.4")).toBe(true);
    expect(
      found.models.some((model) => model.id === "moonshotai/Kimi-K3"),
    ).toBe(true);
    // Every Claude model is explained, none is offered.
    expect(found.unsupported!.map((model) => model.id).sort()).toEqual(
      [...anthropic].sort(),
    );
    for (const model of found.unsupported!)
      expect(model).toMatchObject({
        reason: "protocol",
        protocol: "@ai-sdk/anthropic",
        name: expect.stringMatching(/^Claude /),
      });
    expect(found.models.some((model) => anthropic.includes(model.id))).toBe(
      false,
    );
    // Nothing goes missing.
    expect(found.models.length + found.unsupported!.length).toBe(
      Object.keys(listed).length,
    );
    // The catalog is public: the key is not part of that request.
    expect(JSON.stringify(send.mock.calls)).not.toContain("sk-secret");
  });

  it("tries the key against Command Code's own /models, so a wrong one is caught before a chat", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!String(url).startsWith(COMMAND_CODE.baseUrl))
        return Response.json(snapshot);
      expect(String(url)).toBe(`${COMMAND_CODE.baseUrl}/models`);
      return new Headers(init?.headers).get("authorization") === "Bearer good"
        ? Response.json({ object: "list", data: [] })
        : Response.json({ error: "unauthorized" }, { status: 401 });
    });
    expect(
      await listProviderModels({
        reference: COMMAND_CODE,
        apiKey: "bad",
        fetch: send,
      }),
    ).toMatchObject({ failure: "http", status: 401 });
    const ok = await listProviderModels({
      reference: COMMAND_CODE,
      apiKey: "good",
      fetch: send,
    });
    expect(ok.failure).toBeUndefined();
    expect(ok.models.length).toBeGreaterThan(0);
  });
});

describe("running a Command Code model", () => {
  it("answers one turn over a local stand-in of /chat/completions", async () => {
    const found = await discoverModels({
      reference: COMMAND_CODE,
      fetch: serving(snapshot),
    });
    const kimi = found.models.find(
      (model) => model.id === "moonshotai/Kimi-K3",
    )!;
    const seen: {
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }[] = [];
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        model: kimi.id,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        });
        const events = [
          chunk({ role: "assistant", content: "Hello " }),
          chunk({ content: "there." }),
          chunk({}, "stop"),
        ];
        return new Response(`${events.join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const { models, failed } = await buildModels([
        {
          id: "command-code",
          name: "Command Code",
          kind: "commandcode",
          // The real address is the preset's; the stand-in is local, under the same path.
          baseUrl: `http://127.0.0.1:${endpoint.port}/provider/v1`,
          apiKey: "sk-cmd-test",
          models: [kimi],
        },
      ]);
      expect(failed).toEqual([]);
      const model = models!.getModel("command-code", kimi.id)!;
      expect(model.api).toBe("openai-completions");
      const context: Context = {
        systemPrompt: "You are a test.",
        messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
      };
      const texts: string[] = [];
      const stream = models!.streamSimple(model, context);
      for await (const event of stream)
        if (event.type === "text_delta") texts.push(event.delta);
      const answer: AssistantMessage = await stream.result();
      expect(texts.join("")).toBe("Hello there.");
      expect(answer.stopReason).toBe("stop");

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        path: "/provider/v1/chat/completions",
        authorization: "Bearer sk-cmd-test",
        body: {
          model: "moonshotai/Kimi-K3",
          stream: true,
          max_tokens: expect.any(Number),
          messages: [
            { role: "system", content: "You are a test." },
            { role: "user" },
          ],
        },
      });
      expect(seen[0]!.body).not.toHaveProperty("store");
      expect(seen[0]!.body).not.toHaveProperty("max_completion_tokens");
    } finally {
      await endpoint.stop(true);
    }
  });
});
