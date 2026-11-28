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
 * What a request to it carries (Chat Completions without `store` or `max_completion_tokens`) is
 * its row in the golden table of `providers-runtime.test.ts`; its models.dev id is a row of the
 * preset table in `providers-metadata.test.ts`.
 *
 * Nothing here reaches commandcode.ai or models.dev.
 */
import { MODEL_SOURCES } from "@eta/client-contracts";
import { describe, expect, it, vi } from "vitest";
import { discoverModels } from "../src/providers/discovery";
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
});
