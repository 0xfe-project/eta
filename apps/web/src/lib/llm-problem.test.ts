import { LLM_CODES } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { i18n } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import { WireError } from "@/lib/wire";
import { wireErrorMessage } from "@/queries/wire";

afterEach(async () => {
  await i18n.changeLanguage("zh");
});

const PARAMS = { provider: "Codex", status: 403 };

describe("llmProblemText", () => {
  it("tells a code in Chinese and in English, filling its params", async () => {
    const problem = {
      code: "model_forbidden",
      message: "diagnostic only",
      params: PARAMS,
    };
    await i18n.changeLanguage("zh");
    expect(llmProblemText(problem)).toBe(
      "Codex 账号无权使用该模型（HTTP 403）。",
    );
    await i18n.changeLanguage("en");
    expect(llmProblemText(problem)).toBe(
      "The Codex account isn't allowed to use this model (HTTP 403).",
    );
    expect(llmProblemText({ code: "login_expired", message: "x" })).toBe(
      "The login has expired. Sign in again.",
    );
  });

  it("never shows the diagnostic of a code it knows", async () => {
    await i18n.changeLanguage("en");
    expect(
      llmProblemText({ code: "rate_limited", message: "Too many requests" }),
    ).not.toContain("Too many requests;");
  });

  it("has a text in both languages for every code, with no placeholder left over", async () => {
    for (const language of ["zh", "en"]) {
      await i18n.changeLanguage(language);
      for (const code of LLM_CODES) {
        const text = llmProblemText({ code, message: "m", params: PARAMS });
        expect(text, `${language} ${code}`).not.toContain("problems.");
        expect(text, `${language} ${code}`).not.toContain("{{");
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it("shows an unknown code with the gateway's diagnostic", async () => {
    const problem = { code: "brand_new", message: "Something new broke." };
    await i18n.changeLanguage("en");
    expect(llmProblemText(problem)).toBe(
      "Unknown error (brand_new): Something new broke.",
    );
    await i18n.changeLanguage("zh");
    expect(llmProblemText(problem)).toBe(
      "未知错误（brand_new）：Something new broke.",
    );
  });

  it("translates a failed wire call that carries a problem", async () => {
    await i18n.changeLanguage("en");
    const error = new WireError("server", "The API key is empty.", {
      code: "api_key_required",
    });
    expect(wireErrorMessage(error)).toBe("Enter an API key.");
    expect(wireErrorMessage(new WireError("server", "plain words"))).toBe(
      "plain words",
    );
  });
});
