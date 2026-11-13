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
    keys: "Keys in a conversation",
    keysScroll: "Scroll",
    keysSearch: "Search",
    keysSelect: "Select lines",
    keysExpandAll: "Expand all",
    keysToggleTurn: "Unfold or fold one reply's tool calls",
    keysNewline: "New line",
    keysSteer: "Steer",
    keysStop: "Stop the reply",
    mouseOn:
      "The wheel scrolls the conversation. To select text with the mouse, hold Shift while dragging (the terminal's own selection, in most terminals)",
    mouseOff:
      "To select with the mouse, use your terminal's own selection (many terminals need Shift held while dragging)",
  },
  zh: {
    title: "命令",
    arguments: "参数",
    examples: "例子",
    required: "必填",
    optional: "选填",
    close: "Esc 关闭",
    noSuchCommand: "没有 /{name} 这条命令",
    keys: "对话里的键",
    keysScroll: "滚动",
    keysSearch: "搜索",
    keysSelect: "选取",
    keysExpandAll: "全部展开",
    keysToggleTurn: "展开或收起一轮回复的工具调用",
    keysNewline: "换行",
    keysSteer: "插话",
    keysStop: "停止回复",
    mouseOn:
      "滚轮滚动对话。要用鼠标选取文字，按住 Shift 拖动（终端自己的选取，多数终端如此）",
    mouseOff: "要用鼠标选取，直接用终端自己的选取（不少终端要按住 Shift 拖动）",
  },
});
