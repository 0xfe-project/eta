import type { Extension, SlashCommand } from "../../extensions/types";
import { translatorFor } from "../../i18n/messages";
import { CommandDetail, CommandList } from "./layers";
import { helpMessages } from "./messages";

const help: SlashCommand = {
  name: "help",
  args: [
    {
      name: "command",
      required: false,
      summary: {
        en: "The command to explain, without the slash",
        zh: "要查看的命令名，不带斜杠",
      },
    },
  ],
  summary: {
    en: "List the commands, or show how to use one",
    zh: "列出全部命令，或查看一条命令的用法",
  },
  examples: [
    {
      input: "/help",
      summary: { en: "List every command", zh: "列出全部命令" },
    },
    {
      input: "/help config",
      summary: { en: "Show how to use /config", zh: "查看 /config 的用法" },
    },
  ],
  requiredOps: [],
  run: (ctx, argText) => {
    if (argText === "") {
      ctx.openLayer((handle) => (
        <CommandList commands={ctx.commands} handle={handle} />
      ));
      return;
    }
    const name = argText.replace(/^\//, "");
    const command = ctx.commands.find((c) => c.name === name);
    if (!command) {
      ctx.notify(
        translatorFor(helpMessages, ctx.locale)("noSuchCommand", { name }),
        "error",
      );
      return;
    }
    ctx.openLayer((handle) => (
      <CommandDetail command={command} handle={handle} />
    ));
  },
};

const extension: Extension = {
  id: "help",
  messages: helpMessages,
  commands: [help],
};

export default extension;
