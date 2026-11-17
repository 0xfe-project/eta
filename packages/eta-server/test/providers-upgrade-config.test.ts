/**
 * A config.json written by 0.4.0-rc.3, read by this build: the upgrade question #601 left open.
 *
 * What a session generates through is not the config file but the `Model` objects built from it —
 * the protocol, the base URL, the headers, the thinking levels, and the `compat` flags that decide
 * which keys the request may carry. Those came from a checked-in `catalog.json` in rc.3 and from
 * `MODEL_SOURCES` here, and moving the data must not move a single one of them: an extra `store`
 * key or a lost thinking level is a request a gateway refuses, long after the upgrade looked fine.
 *
 * The fixture is one rc.3 wrote with every kind of source people had: Eta Token Plan, Codex
 * (signed in, no key), Kimi for Coding, Command Code, a coding-plan GLM, an endpoint of one's own
 * with a header, and one entry from before `kind` existed at all. The values below were taken from
 * rc.3's own build of the same file; the test exists so a later refactor cannot quietly change
 * them. (Not a copy of rc.3's code: the numbers are what a request carried.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProvider } from "../src/providers/runtime";
import { ProviderConfigStore } from "../src/providers/store";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "config-0.4.0-rc.3.json",
);

/** What a gateway is sent, for one model. */
interface Requested {
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat: Record<string, unknown>;
  sessionHeader?: string;
  input: string[];
}

const CHAT_COMPLETIONS_COMPAT = {
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
};

const EXPECTED: Record<
  string,
  { baseUrl: string; header?: string; models: Record<string, Requested> }
> = {
  "eta-token-plan": {
    baseUrl: "https://eta.0xfe.tech/v1",
    models: {
      "claude-sonnet-5": {
        api: "openai-completions",
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: CHAT_COMPLETIONS_COMPAT,
        input: ["text", "image"],
      },
      "qwen3.8-max-0902": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: CHAT_COMPLETIONS_COMPAT,
        input: ["text"],
      },
    },
  },
  codex: {
    baseUrl: "https://chatgpt.com/backend-api",
    models: {
      "gpt-5.4": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
      "gpt-5.3-codex-spark": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
  kimi: {
    baseUrl: "https://api.kimi.com/coding/v1",
    models: {
      k3: {
        api: "openai-completions",
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        reasoning: true,
        // `only`: there is no switch to turn thinking off, so `off` is not offered.
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        compat: { supportsStrictMode: false },
        input: ["text", "image"],
      },
      "kimi-for-coding": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
  commandcode: {
    baseUrl: "https://api.commandcode.ai/provider/v1",
    models: {
      "claude-sonnet-5": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: CHAT_COMPLETIONS_COMPAT,
        input: ["text"],
      },
      // A model that says it speaks Responses keeps only the flag pi-ai needs either way.
      "gpt-5.4": {
        api: "openai-responses",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
  zai: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    models: {
      "glm-5.3": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
        // The coding plan has no "thinking off": rc.3's `thinking: "zai"` is `noThinkingOff`.
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
  "my-endpoint": {
    baseUrl: "https://llm.example.test/v1",
    // The config's own User-Agent wins over the one eta attributes itself with.
    header: "eta-smoke",
    models: {
      "my-model": {
        api: "openai-completions",
        contextWindow: 64_000,
        maxTokens: 4_096,
        reasoning: true,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: { supportsStrictMode: false },
        input: ["text", "image"],
      },
      "plain-model": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: false,
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
  // An entry from before `kind` existed: custom Chat Completions, and no compat of a known kind.
  legacy: {
    baseUrl: "https://legacy.example.test/v1",
    models: {
      "legacy-model": {
        api: "openai-completions",
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: { supportsStrictMode: false },
        input: ["text"],
      },
    },
  },
};

describe("a config.json from 0.4.0-rc.3", () => {
  it("builds the same models it built before, provider by provider", async () => {
    const store = new ProviderConfigStore({
      path: FIXTURE,
      watchIntervalMs: 0,
    });
    const { config } = await store.read();
    const providers = config.providers ?? [];
    expect(providers.map((provider) => provider.id).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );

    for (const configured of providers) {
      const expected = EXPECTED[configured.id]!;
      const built = await buildProvider(configured);
      expect(built.baseUrl).toBe(expected.baseUrl);
      if (expected.header !== undefined)
        expect(
          (built as { headers?: Record<string, string> }).headers?.[
            "User-Agent"
          ],
        ).toBe(expected.header);

      const models = built.getModels();
      expect(models.map((model) => model.id).sort()).toEqual(
        Object.keys(expected.models).sort(),
      );
      for (const model of models) {
        const wanted = expected.models[model.id]!;
        const got = model as unknown as Record<string, unknown>;
        expect({
          id: model.id,
          api: got.api,
          contextWindow: got.contextWindow,
          maxTokens: got.maxTokens,
          reasoning: got.reasoning,
          ...(wanted.thinkingLevelMap === undefined
            ? {}
            : { thinkingLevelMap: got.thinkingLevelMap }),
          compat: got.compat,
          ...(got.sessionHeader === undefined
            ? {}
            : { sessionHeader: got.sessionHeader }),
          input: got.input,
        }).toEqual({ id: model.id, ...wanted });
      }
    }
  });

  it("keeps the file exactly as it is: reading a config never writes one", async () => {
    const before = readFileSync(FIXTURE, "utf8");
    const store = new ProviderConfigStore({
      path: FIXTURE,
      watchIntervalMs: 0,
    });
    await store.read();
    await store.view();
    expect(readFileSync(FIXTURE, "utf8")).toBe(before);
  });
});
