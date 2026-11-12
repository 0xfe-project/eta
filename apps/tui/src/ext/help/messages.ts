import { defineMessages } from "../../i18n/messages";

export const helpMessages = defineMessages({
  en: {
    title: "Commands",
    arguments: "Arguments",
    examples: "Examples",
    required: "required",
    optional: "optional",
    close: "Esc to close",
    noSuchCommand: "No command /{name}",
  },
  zh: {
    title: "命令",
    arguments: "参数",
    examples: "例子",
    required: "必填",
    optional: "选填",
    close: "Esc 关闭",
    noSuchCommand: "没有 /{name} 这条命令",
  },
});
