/**
 * What a failed call tells the user: the wire's own failures in both languages, the gateway's
 * codes in the words the web page uses, the host's message for everything else, and one real
 * failure from a real host.
 */
import type { LlmCode } from "@eta/client-contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLM_CODES } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { WireError } from "../../src/connection/wire";
import { callErrorText } from "../../src/ext/kit/errors";

const webLocales = resolve(import.meta.dirname, "../../../web/src/locales");

function webProblems(locale: "en" | "zh"): Record<string, string> {
  const file = JSON.parse(
    readFileSync(resolve(webLocales, locale, "llm.json"), "utf8"),
  ) as { problems: Record<string, string> };
  return file.problems;
}

/** The web's key for a code (`login_expired` is `loginExpired`), and its `{{x}}` as `{x}`. */
function webText(
  locale: "en" | "zh",
  code: LlmCode,
  params: { provider: string; status: string },
): string {
  const key = code.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const template = webProblems(locale)[key];
  if (template === undefined)
    throw new Error(`the web has no text for ${code}`);
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, name: "provider" | "status") => params[name],
  );
}

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
  )("%s %s reads as the web page reads it", (locale, code) => {
    const error = new WireError("server", "diagnostic", {
      code,
      params: { provider: "Grok", status: 429 },
    });
    const text = callErrorText(error, locale);
    expect(text).toBe(
      webText(locale, code, { provider: "Grok", status: "429" }),
    );
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toBe("diagnostic");
  });
});
