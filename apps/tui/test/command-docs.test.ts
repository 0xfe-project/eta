import type { SlashCommand } from "../src/extensions/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCommandDocs } from "../scripts/gen-docs";
import { extensions } from "../src/extensions.gen";
import { createRegistry } from "../src/extensions/registry";

const docsDir = resolve(import.meta.dirname, "../../../docs/tui");
const REGENERATE = "bun run --cwd apps/tui docs";

describe("docs/tui/commands*.md", () => {
  const commands = createRegistry(extensions).commands;

  it.each([
    ["en", "commands.md"],
    ["zh", "commands.zh.md"],
  ] as const)(
    "the %s file matches what the registry generates",
    (locale, file) => {
      const expected = renderCommandDocs(commands, locale);
      const actual = readFileSync(resolve(docsDir, file), "utf8").replaceAll(
        "\r\n",
        "\n",
      );
      expect(
        actual === expected,
        `docs/tui/${file} is out of date. Run \`${REGENERATE}\`.`,
      ).toBe(true);
    },
  );
});

describe("renderCommandDocs", () => {
  const sample: SlashCommand[] = [
    {
      name: "zap",
      args: [
        {
          name: "target",
          required: true,
          summary: { en: "What to zap", zh: "要清掉的东西" },
        },
        {
          name: "mode",
          required: false,
          summary: { en: "How hard", zh: "力度" },
        },
      ],
      summary: { en: "Zap a thing", zh: "清掉一个东西" },
      examples: [
        {
          input: "/zap all",
          summary: { en: "Zap everything", zh: "全部清掉" },
        },
      ],
      requiredOps: [],
      run: () => {},
    },
    {
      name: "alpha",
      args: [],
      summary: { en: "First one", zh: "第一个" },
      examples: [],
      requiredOps: [],
      run: () => {},
    },
  ];

  it("writes usage, summary, arguments and examples in the chosen language, sorted by name", () => {
    const en = renderCommandDocs(sample, "en");
    expect(en.indexOf("/alpha")).toBeLessThan(en.indexOf("/zap"));
    expect(en).toContain("/zap <target> [mode]");
    expect(en).toContain("Zap a thing");
    expect(en).toContain("What to zap");
    expect(en).toContain("How hard");
    expect(en).toContain("/zap all");
    expect(en).toContain("Zap everything");
    expect(en).not.toContain("清掉");

    const zh = renderCommandDocs(sample, "zh");
    expect(zh).toContain("/zap <target> [mode]");
    expect(zh).toContain("清掉一个东西");
    expect(zh).toContain("要清掉的东西");
    expect(zh).toContain("全部清掉");
    expect(zh).not.toContain("Zap a thing");
  });
});
