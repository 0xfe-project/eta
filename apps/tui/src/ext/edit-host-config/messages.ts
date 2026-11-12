import { defineMessages } from "../../i18n/messages";

export const editHostConfigMessages = defineMessages({
  en: {
    pickTitle: "Edit which of the host's files?",
    pickFooter: "↑↓ or a digit to choose · Enter to open · Esc to close",
    configHint: "The host's model providers",
    mcpHint: "The MCP servers every session on the host gets",
    unknownFile: "Unknown file {name}: choose config.json or mcp.json",
    opening: "Opening {path}",
    openingResident: "Opening {path} (the host is taken to run as you)",
    reloaded: "The host read {path} again",
    reloadFailed: "The host did not read {path} again: {error}",
    savedNoReload: "Saved {path}; this host cannot be asked to read it again",
    mcpSaved:
      "Saved {path}. Sessions read it when they next open; connected servers can be reconnected in /mcp",
    exited: "{program} exited with code {code}; nothing was reloaded",
    remoteTitle: "{file} is on the host's computer",
    remoteWhere: "It is at ~/.eta/{file} on the host's computer.",
    remoteHow:
      "Set ssh.target in /config (such as me@server) to edit it from here.",
    remoteFooter: "Any key closes",
    sshTargetOption:
      "ssh.target {target} starts with -, which ssh would read as an option; set it to user@host in /config",
  },
  zh: {
    pickTitle: "编辑 host 的哪个文件？",
    pickFooter: "↑↓ 或数字选择 · Enter 打开 · Esc 关闭",
    configHint: "host 的模型 provider 设定",
    mcpHint: "host 上每个会话都会用到的 MCP 服务器",
    unknownFile: "没有 {name} 这个文件：可选 config.json 或 mcp.json",
    opening: "正在打开 {path}",
    openingResident: "正在打开 {path}（假定 host 以你的身份运行）",
    reloaded: "host 已重新读取 {path}",
    reloadFailed: "host 没能重新读取 {path}：{error}",
    savedNoReload: "已保存 {path}；这个 host 不能通知它重新读取",
    mcpSaved:
      "已保存 {path}。会话下次打开时读到；已连接的服务器可以在 /mcp 里重连",
    exited: "{program} 以退出码 {code} 结束；没有重新载入任何东西",
    remoteTitle: "{file} 在 host 所在的电脑上",
    remoteWhere: "它在 host 所在电脑的 ~/.eta/{file}。",
    remoteHow:
      "在 /config 里设好 ssh.target（例如 me@server）就能在这里直接改。",
    remoteFooter: "按任意键关闭",
    sshTargetOption:
      "ssh.target {target} 以 - 开头，ssh 会把它当成选项；请在 /config 里改成 user@host 的写法",
  },
});
