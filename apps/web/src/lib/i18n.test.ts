import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setI18n } from "react-i18next";
import ts from "typescript";
import { agentFormSchema } from "@/components/workspace/agent-form";
import { describeSchedule } from "@/components/workspace/routine-format";
import { ago, statusLabel } from "@/components/workspace/task-format";
import en from "@/locales/en.json";
import zh from "@/locales/zh.json";
import {
  createI18n,
  detectLanguage,
  formatLocale,
  i18n,
  languageStorageKey,
  readLanguagePreference,
  resolveLanguage,
  setLanguagePreference,
  translate,
} from "./i18n";
import { mentionedMembers } from "./mentions";

afterEach(() => {
  rstest.restoreAllMocks();
  localStorage.removeItem(languageStorageKey);
  setLanguagePreference("system");
  localStorage.removeItem(languageStorageKey);
  setI18n(i18n);
});

describe("language detection and preferences", () => {
  it.each([
    [["zh-CN"], "zh"],
    [["zh-TW"], "zh"],
    [["ZH_Hans"], "zh"],
    [["en-GB"], "en"],
    [["de-DE", "zh-HK", "en"], "zh"],
    [["fr-FR", "ja-JP"], "en"],
    [[], "en"],
  ] as const)("detects %s as %s", (languages, expected) => {
    expect(detectLanguage(languages)).toBe(expected);
  });

  it("uses browser languages by default and honors saved choices", () => {
    rstest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    expect(readLanguagePreference()).toBe("system");
    expect(resolveLanguage("system")).toBe("zh");
    setLanguagePreference("en");
    expect(readLanguagePreference()).toBe("en");
    expect(i18n.resolvedLanguage).toBe("en");
    expect(JSON.parse(localStorage.getItem(languageStorageKey)!)).toBe("en");
    setLanguagePreference("zh");
    expect(i18n.resolvedLanguage).toBe("zh");
    setLanguagePreference("system");
    expect(i18n.resolvedLanguage).toBe("zh");
  });

  it.each(["invalid JSON", '"fr"', "{}", '"zh-CN"'])(
    "ignores corrupt or unsupported preference %s",
    (saved) => {
      localStorage.setItem(languageStorageKey, saved);
      expect(readLanguagePreference()).toBe("system");
    },
  );

  it("can switch and retain the choice when storage is blocked", () => {
    rstest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setLanguagePreference("zh");
    expect(i18n.resolvedLanguage).toBe("zh");
    expect(readLanguagePreference()).toBe("zh");
  });

  it("starts SSR in English and falls back to English for missing resources", () => {
    const instance = createI18n();
    expect(instance.isInitialized).toBe(true);
    expect(instance.t("设置")).toBe("Settings");
    void instance.changeLanguage("fr");
    expect(instance.t("设置")).toBe("Settings");
    instance.addResource(
      "en",
      "translation",
      "fallback-test",
      "English fallback",
    );
    void instance.changeLanguage("zh");
    expect(instance.t("fallback-test")).toBe("English fallback");
  });
});

describe("live translations", () => {
  it("updates utilities, weekdays, plurals, locale and validation after switching", () => {
    setLanguagePreference("zh");
    expect(statusLabel("todo")).toBe("待办");
    expect(formatLocale()).toBe("zh-CN");
    expect(
      describeSchedule({ kind: "weekly", days: [1, 5], time: "08:00" }),
    ).toBe("每周一、五 08:00");
    const values = { name: "", description: "", model: "", bundles: null };
    expect(agentFormSchema.safeParse(values).error?.issues[0].message).toBe(
      "请输入名称。",
    );
    setLanguagePreference("en");
    expect(statusLabel("todo")).toBe("To do");
    expect(formatLocale()).toBe("en-US");
    expect(
      describeSchedule({ kind: "weekly", days: [1, 5], time: "08:00" }),
    ).toBe("Weekly on Mon, Fri at 08:00");
    expect(agentFormSchema.safeParse(values).error?.issues[0].message).toBe(
      "Enter a name.",
    );
    expect(translate("{{value1}} 位成员", { value1: 1, count: 1 })).toBe(
      "1 member",
    );
    expect(translate("{{value1}} 位成员", { value1: 2, count: 2 })).toBe(
      "2 members",
    );
    expect(ago(new Date(Date.now() - 65_000).toISOString())).toBe(
      "1 minute ago",
    );
    expect(translate("删除「{{value1}}」？", { value1: "<Agent>" })).toBe(
      "Delete “<Agent>”?",
    );
  });

  it("keeps both everyone mention aliases valid in drafts across languages", () => {
    const members = [
      { agent_id: "a", name: "Alice" },
      { agent_id: "b", name: "Bob" },
    ];
    for (const language of ["en", "zh"] as const) {
      setLanguagePreference(language);
      expect(mentionedMembers("@everyone hello", members)).toEqual(["a", "b"]);
      expect(mentionedMembers("@所有人 你好", members)).toEqual(["a", "b"]);
    }
  });
});

describe("translation coverage", () => {
  it("covers built-in bundle, plugin and configuration descriptions", () => {
    const missing: string[] = [];
    function inspect(value: unknown) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (
          ["title", "description"].includes(key) &&
          typeof child === "string" &&
          /\p{Script=Han}/u.test(child) &&
          !(child in en)
        )
          missing.push(child);
        if (typeof child === "object") inspect(child);
      }
    }
    const root = join(process.cwd(), "../..");
    for (const dir of ["bundles", "plugins"]) {
      for (const entry of readdirSync(join(root, dir), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const file = join(
          root,
          dir,
          entry.name,
          dir === "bundles" ? "bundle.json" : "plugin.json",
        );
        try {
          inspect(JSON.parse(readFileSync(file, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    expect(missing).toEqual([]);
  });
  it("has matching catalogs and interpolation variables, with complete English text", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    const variables = (text: string) =>
      [...text.matchAll(/\{\{.*?\}\}/g)].map((match) => match[0]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe("");
      expect(zh[key].trim(), key).not.toBe("");
      expect(en[key], key).not.toMatch(/\p{Script=Han}/u);
      expect(variables(en[key]), key).toEqual(variables(zh[key]));
    }
  });

  it("covers every literal translation key used in the application", () => {
    const missing: string[] = [];
    function scan(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (/\.tsx?$/.test(file) && !/\.(?:test|gen)\./.test(file)) {
          const source = ts.createSourceFile(
            file,
            readFileSync(file, "utf8"),
            ts.ScriptTarget.Latest,
            true,
          );
          function visit(node: ts.Node) {
            if (
              ts.isCallExpression(node) &&
              ["t", "translate", "translateText"].includes(
                node.expression.getText(source),
              ) &&
              node.arguments[0] &&
              ts.isStringLiteral(node.arguments[0])
            ) {
              const key = node.arguments[0].text;
              if (!(key in en)) missing.push(`${file}: ${key}`);
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    scan(join(process.cwd(), "src"));
    expect(missing).toEqual([]);
  });
});
