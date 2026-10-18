import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setI18n } from "react-i18next";
import ts from "typescript";
import { agentFormSchema } from "@/components/workspace/agent-form";
import { describeSchedule } from "@/components/workspace/routine-format";
import { ago, statusLabel } from "@/components/workspace/task-format";
import { en, namespaces, zh } from "@/locales/resources";
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

  it("starts in English and falls back to English for missing resources", () => {
    const instance = createI18n();
    expect(instance.isInitialized).toBe(true);
    expect(instance.t("settings:title")).toBe("Settings");
    void instance.changeLanguage("fr");
    expect(instance.t("settings:title")).toBe("Settings");
    instance.removeResourceBundle("zh", "common");
    void instance.changeLanguage("zh");
    expect(instance.t("common:actions.save")).toBe("Save");
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
    const values = {
      name: "",
      description: "",
      model: "",
      persona: "",
      thinkingLevel: "",
    };
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
    expect(translate("chat:groups.members.count", { count: 1 })).toBe(
      "1 member",
    );
    expect(translate("chat:groups.members.count", { count: 2 })).toBe(
      "2 members",
    );
    expect(ago(new Date(Date.now() - 65_000).toISOString())).toBe(
      "1 minute ago",
    );
    expect(translate("agents:delete.confirmTitle", { name: "<Agent>" })).toBe(
      "Delete “<Agent>”?",
    );
  });

  it("keeps both everyone mention aliases valid in drafts across languages", () => {
    const members = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ];
    for (const language of ["en", "zh"] as const) {
      setLanguagePreference(language);
      expect(mentionedMembers("@everyone hello", members)).toEqual(["a", "b"]);
      expect(mentionedMembers("@所有人 你好", members)).toEqual(["a", "b"]);
    }
  });
});

function flatten(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === "string"
        ? [[path, child]]
        : Object.entries(flatten(child, path));
    }),
  );
}

const catalog = Object.fromEntries(
  namespaces.flatMap((namespace) =>
    Object.entries(flatten(en[namespace])).map(([key, text]) => [
      `${namespace}:${key}`,
      text,
    ]),
  ),
);

describe("translation coverage", () => {
  it("has matching semantic keys, English text and named interpolation variables", () => {
    expect(Object.keys(en).sort()).toEqual([...namespaces].sort());
    expect(Object.keys(zh).sort()).toEqual([...namespaces].sort());
    const variables = (text: string) =>
      [...text.matchAll(/\{\{.*?\}\}/g)].map((match) => match[0]).sort();
    for (const namespace of namespaces) {
      const english = flatten(en[namespace]);
      const chinese = flatten(zh[namespace]);
      expect(Object.keys(english).sort(), namespace).toEqual(
        Object.keys(chinese).sort(),
      );
      for (const [key, text] of Object.entries(english)) {
        const id = `${namespace}:${key}`;
        expect(key, id).toMatch(
          /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*(?:_(?:one|other))?$/,
        );
        expect(text.trim(), id).not.toBe("");
        expect(chinese[key].trim(), id).not.toBe("");
        expect(text, id).not.toMatch(/\p{Script=Han}/u);
        expect(text, id).not.toMatch(/\{\{value\d+\}\}/);
        expect(variables(text), id).toEqual(variables(chinese[key]));
      }
    }
  });

  it("requires explicit namespaces and resolves every literal source key", () => {
    const errors: string[] = [];
    function scan(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (/\.tsx?$/.test(file) && !/\.(?:test|gen|d)\./.test(file)) {
          const source = ts.createSourceFile(
            file,
            readFileSync(file, "utf8"),
            ts.ScriptTarget.Latest,
            true,
          );
          const scopes: string[] = [];
          function findScopes(node: ts.Node) {
            if (
              ts.isCallExpression(node) &&
              node.expression.getText(source) === "useTranslation"
            ) {
              let argument = node.arguments[0];
              if (argument && ts.isAsExpression(argument))
                argument = argument.expression;
              if (argument && ts.isStringLiteral(argument))
                scopes.push(argument.text);
              else if (
                argument &&
                ts.isArrayLiteralExpression(argument) &&
                argument.elements.every(ts.isStringLiteral)
              ) {
                scopes.push((argument.elements[0] as ts.StringLiteral).text);
                for (const scope of argument.elements) {
                  if (
                    !namespaces.includes(
                      (scope as ts.StringLiteral)
                        .text as (typeof namespaces)[number],
                    )
                  )
                    errors.push(
                      `${file}: unknown namespace ${scope.getText(source)}`,
                    );
                }
              } else
                errors.push(
                  `${file}: useTranslation needs an explicit namespace`,
                );
            }
            ts.forEachChild(node, findScopes);
          }
          findScopes(source);
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
              const scope =
                node.expression.getText(source) === "translate" ? [] : scopes;
              const candidates = key.includes(":")
                ? [key]
                : scope.map((namespace) => `${namespace}:${key}`);
              const id = candidates.find((candidate) => candidate in catalog);
              if (!id) errors.push(`${file}: ${key}`);
              else {
                const variables = [
                  ...catalog[id].matchAll(/\{\{\s*(\w+)\s*\}\}/g),
                ].map((match) => match[1]);
                const options = node.arguments[1];
                const supplied =
                  options && ts.isObjectLiteralExpression(options)
                    ? options.properties.map((property) =>
                        property.name?.getText(source),
                      )
                    : [];
                for (const variable of variables) {
                  if (!supplied.includes(variable))
                    errors.push(
                      `${file}: ${key} needs interpolation ${variable}`,
                    );
                }
              }
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    scan(join(process.cwd(), "src"));
    expect(errors).toEqual([]);
  });

  it("rejects unknown namespaces, missing keys and natural-language keys at compile time", () => {
    // These unreachable calls make typecheck verify the resource augmentation.
    if (false) {
      // @ts-expect-error: unknown namespace
      translate("unknown:actions.save");
      // @ts-expect-error: missing semantic key
      translate("tasks:missing.key");
      // @ts-expect-error: Chinese text is not a key
      translate("保存");
    }
    expect(i18n.options.keySeparator).toBe(".");
    expect(i18n.options.nsSeparator).toBe(":");
  });
});
