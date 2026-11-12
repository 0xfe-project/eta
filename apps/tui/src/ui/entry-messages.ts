import { defineMessages } from "../i18n/messages";

/** What `eta` prints before the interface opens: the usage and the argument problems. */
export const mainMessages = defineMessages({
  en: {
    usage: [
      "Usage: eta [--version | --help]",
      "",
      "Opens the terminal interface of an eta host.",
      "",
      "Options:",
      "  --version       Print the version",
      "  --help, -h      Print this help",
      "",
      "Settings file: {config}",
      "",
      "Environment:",
      "  ETA_TUI_CONFIG  Use this settings file instead",
      "  ETA_TOKEN       The token for the resident host, over the one in the settings",
      "  ETA_HOST_BIN    The eta-host program to start or install",
    ].join("\n"),
    unknownArgument: "eta: unknown argument {arg}",
    needsTerminal:
      "eta needs to run in a terminal: stdin and stdout must both be one.",
  },
  zh: {
    usage: [
      "用法：eta [--version | --help]",
      "",
      "打开 eta host 的终端界面。",
      "",
      "选项：",
      "  --version       显示版本",
      "  --help, -h      显示这份说明",
      "",
      "设定文件：{config}",
      "",
      "环境变量：",
      "  ETA_TUI_CONFIG  改用这个设定文件",
      "  ETA_TOKEN       常驻 host 的令牌，优先于设定里的",
      "  ETA_HOST_BIN    要启动或安装的 eta-host 程序",
    ].join("\n"),
    unknownArgument: "eta：不认识的参数 {arg}",
    needsTerminal: "eta 需要在终端里运行：stdin 和 stdout 都得是终端。",
  },
});
