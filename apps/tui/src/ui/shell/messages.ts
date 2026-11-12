import { defineMessages } from "../../i18n/messages";

export const shellMessages = defineMessages({
  en: {
    connected: "Connected to {url}",
    temporaryWarning:
      "Temporary host: agents stop when you quit eta. Run /install-service to install a resident host.",
    versionWarning: "Host version {host} differs from eta {tui}.",
    fallbackWarning:
      "The address in the settings does not answer; connected to the host running on this computer ({url}).",
    settingsNotSaved: "Could not write settings to {file}: {reason}",
    settingsNotJson: "the file is not valid JSON",
    stateNotSaved: "Could not save the open tabs to {file}: {reason}",
    hostLine: "Host {url}",
    hostLineTemporary: "Host {url} (temporary)",
    noConversation: "No conversation is open. Type / to see commands.",
    extensionFailed: "{id} failed: {error}",
    processFailed: "Could not start {command}: {error}",
    actionFailed: "Failed: {error}",
  },
  zh: {
    connected: "已连接 {url}",
    temporaryWarning:
      "临时 host：退出 TUI 后 agent 会停止。用 /install-service 装常驻 host",
    versionWarning: "host 版本 {host} 与 eta {tui} 不一致。",
    fallbackWarning: "设定里的地址连不上，已连到本机正在运行的 host（{url}）。",
    settingsNotSaved: "设定没能写进 {file}：{reason}",
    settingsNotJson: "文件不是合法的 JSON",
    stateNotSaved: "打开的标签没能存进 {file}：{reason}",
    hostLine: "host {url}",
    hostLineTemporary: "host {url}（临时）",
    noConversation: "还没有打开的对话。输入 / 看命令。",
    extensionFailed: "{id} 出错：{error}",
    processFailed: "{command} 起不来：{error}",
    actionFailed: "出错：{error}",
  },
});

export const configProblemMessages = defineMessages({
  en: {
    title: "Some settings were not used",
    line: "{file} · {key}: {reason}",
    wholeFile: "(whole file)",
    unreadable: "cannot read the file",
    "invalid-json": "not valid JSON",
    "not-an-object": "the file must hold a JSON object",
    "wrong-type": "wrong type",
    "invalid-value": "not a valid value",
    "unknown-key": "unknown key",
    withDetail: "{reason} ({detail})",
    footer: "These keys use their default values. Press any key to close.",
  },
  zh: {
    title: "有些设定没有生效",
    line: "{file} · {key}：{reason}",
    wholeFile: "（整个文件）",
    unreadable: "读不了这个文件",
    "invalid-json": "不是合法的 JSON",
    "not-an-object": "文件内容必须是 JSON 对象",
    "wrong-type": "类型不对",
    "invalid-value": "值不合法",
    "unknown-key": "不认识的键",
    withDetail: "{reason}（{detail}）",
    footer: "这些键改用默认值。按任意键关闭。",
  },
});
