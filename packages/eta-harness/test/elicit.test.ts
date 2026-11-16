import type { AskPayload } from "@eta/core/session";
import type { AskResponse } from "../src/ask";
import { describe, expect, it } from "vitest";
import { AskRegistry } from "../src/ask";
import { elicitThroughAsk } from "../src/elicit";

/** A registry whose answers are scripted, one per question, recording what was asked. */
function scripted(answers: AskResponse[]) {
  const asked: AskPayload[] = [];
  const registry = new AskRegistry({
    headless: async (payload) => {
      asked.push(payload);
      return answers.shift() ?? { kind: "none" };
    },
  });
  return { registry, asked };
}

const form = (properties: Record<string, unknown>) => ({
  message: "Pick",
  requestedSchema: { type: "object", properties },
});

describe("elicitThroughAsk", () => {
  it("cancels a request that is not a form, without asking", async () => {
    const { registry, asked } = scripted([]);
    const result = await elicitThroughAsk(
      registry,
      {
        server: "s",
        params: { mode: "url", url: "https://example.com", message: "Go" },
        signal: undefined,
      },
      "e",
    );
    expect(result).toEqual({ action: "cancel" });
    expect(asked).toEqual([]);
  });

  it("cancels when the call is aborted while the user has not answered", async () => {
    const registry = new AskRegistry();
    const controller = new AbortController();
    const pending = elicitThroughAsk(
      registry,
      { server: "s", params: form({}), signal: controller.signal },
      "e",
    );
    expect(registry.pendingAsks().map((ask) => ask.questionId)).toEqual(["e"]);
    controller.abort();
    expect(await pending).toEqual({ action: "cancel" });
  });

  it("asks a multi-select array as one card with every choice", async () => {
    const { registry, asked } = scripted([
      { kind: "selection", selections: ["Continue"] },
      { kind: "selection", selections: ["Red", "Blue"] },
    ]);
    const result = await elicitThroughAsk(
      registry,
      {
        server: "s",
        params: form({
          colors: {
            type: "array",
            title: "Colors",
            items: {
              anyOf: [
                { const: "r", title: "Red" },
                { const: "g", title: "Green" },
                { const: "b", title: "Blue" },
              ],
            },
          },
        }),
        signal: undefined,
      },
      "e",
    );
    expect(asked[1]).toEqual({
      questionId: "e.0",
      question: "Colors (optional)",
      options: ["Red", "Green", "Blue"],
      multi: true,
    });
    expect(result).toEqual({
      action: "accept",
      content: { colors: ["r", "b"] },
    });
  });

  it("gives up on a field typed wrong three times", async () => {
    const { registry, asked } = scripted([
      { kind: "selection", selections: ["Continue"] },
      { kind: "freeform", text: "x" },
      { kind: "freeform", text: "" },
      { kind: "freeform", text: "y" },
    ]);
    const result = await elicitThroughAsk(
      registry,
      {
        server: "s",
        params: form({ n: { type: "number", maximum: 5 } }),
        signal: undefined,
      },
      "e",
    );
    expect(result).toEqual({ action: "cancel" });
    expect(asked.map((ask) => ask.questionId)).toEqual([
      "e",
      "e.0",
      "e.0.1",
      "e.0.2",
    ]);
  });

  it("skips an optional text field answered with -, even after a wrong answer", async () => {
    const { registry, asked } = scripted([
      { kind: "selection", selections: ["Continue"] },
      { kind: "freeform", text: "x" },
      { kind: "selection", selections: ["-"] },
      { kind: "freeform", text: "Ada" },
    ]);
    const result = await elicitThroughAsk(
      registry,
      {
        server: "s",
        params: {
          message: "Who?",
          requestedSchema: {
            type: "object",
            properties: { age: { type: "integer" }, name: { type: "string" } },
            required: ["name"],
          },
        },
        signal: undefined,
      },
      "e",
    );
    expect(asked[1]!.question).toBe("age (optional: answer - to skip)");
    expect(asked[2]!.question).toBe(
      "age (optional: answer - to skip)\nExpected a number.",
    );
    expect(asked[3]!.question).toBe("name");
    expect(result).toEqual({ action: "accept", content: { name: "Ada" } });
  });
});
