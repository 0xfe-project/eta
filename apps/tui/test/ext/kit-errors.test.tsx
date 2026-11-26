/**
 * What a failed call tells the user: the wire's own failures in both languages, the gateway's
 * codes in the user's language with their values filled in, the host's message for everything
 * else, and one real failure from a real host.
 *
 * Reference is the kit's own `llmProblemMessages` rather than `apps/web/src/locales`, which
 * #1003 deleted along with `apps/web`. Exhaustive coverage (every `LlmCode` has a message) is
 * enforced at the type level by `MessageCatalog<LlmCode>` in `errors.ts`; this test guards
 * placeholder interpolation (`{provider}`, `{status}`) and non-fallback to the raw diagnostic.
 */
import { LLM_CODES } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { WireError } from "../../src/connection/wire";
import { callErrorText } from "../../src/ext/kit/errors";
import { llmProblemMessages } from "../../src/ext/kit/messages";

describe("callErrorText for the wire's own failures", () => {
  it.each([
    ["en", "disconnected", "Not connected to the host"],
    ["zh", "disconnected", "没有连上 host"],
    ["en", "timeout", "The host did not answer"],
    ["zh", "timeout", "host 没有回应"],
  ] as const)("%s %s", (locale, code, expected) => {
    expect(callErrorText(new WireError(code, "internal words"), locale)).toBe(
      expected,
    );
  });
});

describe("callErrorText for the host's failures", () => {
  it("uses the host's message for a code it does not know", () => {
    const error = new WireError("server", "something new went wrong", {
      code: "brand_new_code",
    });
    expect(callErrorText(error, "en")).toBe("something new went wrong");
    expect(callErrorText(error, "zh")).toBe("something new went wrong");
  });

  it.each(
    LLM_CODES.flatMap(
      (code) =>
        [
          ["en", code],
          ["zh", code],
        ] as const,
    ),
  )("%s %s is the code in the user's language", (locale, code) => {
    const error = new WireError("server", "diagnostic", {
      code,
      params: { provider: "Grok", status: 429 },
    });
    const text = callErrorText(error, locale);
    const template = llmProblemMessages[locale][code];
    expect(text).not.toBe("");
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toBe("diagnostic");
    if (template.includes("{provider}")) expect(text).toContain("Grok");
    if (template.includes("{status}")) expect(text).toContain("429");
  });
});
