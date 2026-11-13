/**
 * Write the slash command reference from the registry: `docs/tui/commands.md` in English and
 * `docs/tui/commands.zh.md` in Chinese.
 *
 *   bun run --cwd apps/tui docs
 */
import type { Locale } from "../src/config/types";
import type { SlashCommand } from "../src/extensions/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRegistry } from "../src/extensions/registry";
import { commandUsage } from "../src/extensions/usage";
import { localize } from "../src/i18n/messages";

const HEADINGS = {
  en: {
    title: "eta commands",
    other: "[中文](commands.zh.md)",
    intro:
      "Slash commands of the eta terminal interface. Type them in the input line of the home screen or of a conversation; names and arguments are always English.",
    generated:
      "This file is generated from the command registry. Do not edit it: run `bun run --cwd apps/tui docs` to regenerate it.",
    arguments: "Arguments",
    examples: "Examples",
    required: "required",
    optional: "optional",
  },
  zh: {
    title: "eta 命令",
    other: "[English](commands.md)",
    intro:
      "eta 终端界面的斜杠命令，在首页或对话的输入框里输入。命令名和参数名一律是英文。",
    generated:
      "本文件由命令注册表生成，不要手改：运行 `bun run --cwd apps/tui docs` 重新生成。",
    arguments: "参数",
    examples: "例子",
    required: "必填",
    optional: "选填",
  },
} satisfies Record<Locale, Record<string, string>>;

function commandSection(command: SlashCommand, locale: Locale): string[] {
  const h = HEADINGS[locale];
  const lines = [
    `## /${command.name}`,
    "",
    "```text",
    commandUsage(command),
    "```",
    "",
    localize(command.summary, locale),
    "",
  ];
  if (command.args.length > 0) {
    lines.push(`### ${h.arguments}`, "");
    for (const arg of command.args)
      lines.push(
        `- \`${arg.name}\` (${arg.required ? h.required : h.optional}): ${localize(arg.summary, locale)}`,
      );
    lines.push("");
  }
  if (command.examples.length > 0) {
    lines.push(`### ${h.examples}`, "");
    for (const example of command.examples)
      lines.push(
        `- \`${example.input}\`: ${localize(example.summary, locale)}`,
      );
    lines.push("");
  }
  return lines;
}

/** The reference page in one language; commands sorted by name. */
export function renderCommandDocs(
  commands: readonly SlashCommand[],
  locale: Locale,
): string {
  const h = HEADINGS[locale];
  const sorted = [...commands].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const lines = [
    `<!-- ${h.generated} -->`,
    "",
    `# ${h.title}`,
    "",
    h.other,
    "",
    h.intro,
    "",
    ...sorted.flatMap((command) => commandSection(command, locale)),
  ];
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

if (import.meta.main) {
  const { extensions } = await import("../src/extensions.gen");
  const commands = createRegistry(extensions).commands;
  const docs = resolve(import.meta.dir, "../../../docs/tui");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "commands.md"), renderCommandDocs(commands, "en"));
  writeFileSync(
    join(docs, "commands.zh.md"),
    renderCommandDocs(commands, "zh"),
  );
}
