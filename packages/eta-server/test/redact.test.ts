/** What the session's tool results keep: `redactionMiddleware` on its own. */
import type { Redaction } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { redactionMiddleware } from "../src/redact";

const call = { turn: 1, toolCallId: "c" };

const middleware = (redactions: readonly Redaction[]) =>
  redactionMiddleware(() => redactions);

const after = (
  redactions: readonly Redaction[],
  result: unknown,
): Promise<unknown> =>
  Promise.resolve(middleware(redactions).after!("t", {}, result, call));

const key = { value: "sk-abcdefgh", label: "[secret demo.key]" };

describe("the redaction middleware", () => {
  it("replaces every occurrence, in text and in what a result is made of", async () => {
    expect(await after([key], "a sk-abcdefgh b sk-abcdefgh")).toBe(
      "a [secret demo.key] b [secret demo.key]",
    );
    expect(
      await after([key], {
        content: [{ type: "text", text: "got sk-abcdefgh" }],
        details: { nested: ["sk-abcdefgh"], count: 3, flag: true, none: null },
      }),
    ).toEqual({
      content: [{ type: "text", text: "got [secret demo.key]" }],
      details: {
        nested: ["[secret demo.key]"],
        count: 3,
        flag: true,
        none: null,
      },
    });
  });

  it("takes the longer of two values first", async () => {
    expect(
      await after(
        [
          { value: "abcd", label: "[short]" },
          { value: "abcdefgh", label: "[long]" },
        ],
        "abcdefgh abcd",
      ),
    ).toBe("[long] [short]");
  });

  it("leaves a value too short to mean anything", async () => {
    expect(await after([{ value: "a", label: "[x]" }], "banana")).toBe(
      "banana",
    );
  });

  it("hands back the same result when there is nothing to take out", async () => {
    const result = { content: "plain" };
    expect(await after([], result)).toBe(result);
  });

  it("reads the list at each call", async () => {
    const list: Redaction[] = [];
    const live = redactionMiddleware(() => list);
    expect(await live.after!("t", {}, "sk-abcdefgh", call)).toBe("sk-abcdefgh");
    list.push(key);
    expect(await live.after!("t", {}, "sk-abcdefgh", call)).toBe(
      "[secret demo.key]",
    );
  });

  it("covers a running tool's progress too", async () => {
    const seen: unknown[] = [];
    const running = {
      ...call,
      update: (partial: unknown) => seen.push(partial),
    };
    expect(await middleware([key]).before!("t", {}, running)).toEqual({
      ok: true,
      args: {},
    });
    running.update({ text: "sk-abcdefgh" });
    expect(seen).toEqual([{ text: "[secret demo.key]" }]);
  });
});
