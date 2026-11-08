import { defineMessages } from "../../i18n/messages";

export const screenMessages = defineMessages({
  en: {
    starting: "Starting…",
    connecting: "Connecting to {url}…",
    connectingTemporary: "Connecting to the temporary host at {url}…",
    startingTemporary: "Starting a temporary host…",
    stopped: "Quitting…",

    firstRunTitle: "How should eta reach a host?",
    choiceResident: "Connect to a resident host",
    choiceResidentHint:
      "A host that runs on its own, here or on another machine",
    choiceTemporary: "Start a temporary host",
    choiceTemporaryHint: "Runs only while eta is open",
    choiceInstall: "Install a resident host",
    choiceInstallHint: "Installs eta-host as a service on this computer",
    choicesHelp: "Press 1–{count}, or ↑↓ and Enter",

    addressLabel: "Host address",
    tokenLabel: "Token",
    addressHelp: "Enter to connect · Tab to switch fields · Esc to go back",
    addressHelpNoBack: "Enter to connect · Tab to switch fields",
    checking: "Checking {url}…",
    needsToken: "This host needs a token.",
    badToken: "The host rejected this token.",
    unreachableAddress: "No host answers at {url}.",
    invalidAddress: "This is not a valid address.",

    hostMissingTitle: "eta-host is not installed",
    hostMissingTemporary:
      "eta needs eta-host to start a temporary host. Do one of these, then try again:",
    hostMissingInstall:
      "eta needs eta-host to install a resident host. Do one of these, then try again:",
    hostMissingEnv: "Set ETA_HOST_BIN to the path of eta-host",
    hostMissingPath: "Put eta-host on your PATH",
    hostMissingInstallPath: "Install it at {path}",
    anyKeyBack: "Press any key to go back",

    installRunning: "Installing eta-host as a service…",
    installWaiting: "Waiting for the service to start…",
    installFailedTitle: "Could not install the service",
    installFailedRunning: "eta-host install-service did not succeed. It said:",
    installFailedWaiting:
      "The service was installed, but it never started answering. eta-host said:",
    installFailedWayOut:
      "Run eta-host yourself in another terminal or tmux, then choose “Connect to a resident host”.",

    reconnecting: "Reconnecting",
    reconnectingDetail: "{url} · {seconds}s",

    unauthorizedTitle: "The host at {url} rejected the token.",

    unreachableTitle: "Cannot connect",
    unreachableTemporaryFailed: "The temporary host did not start.",
    unreachableTemporaryExited: "The temporary host exited.",
    choiceUseTemporary: "Use a temporary host",
    choiceUseTemporaryHint: "For this run only; the settings keep the address",
    choiceChangeAddress: "Change the address",
    choiceQuit: "Quit",

    quitHint: "Press {key} again to quit",
  },
  zh: {
    starting: "正在启动…",
    connecting: "正在连接 {url}…",
    connectingTemporary: "正在连接临时 host {url}…",
    startingTemporary: "正在启动临时 host…",
    stopped: "正在退出…",

    firstRunTitle: "eta 要怎么连到 host？",
    choiceResident: "连接常驻 host",
    choiceResidentHint: "自己在跑的 host，在本机或别的机器上",
    choiceTemporary: "启动临时 host",
    choiceTemporaryHint: "只在 eta 开着时运行",
    choiceInstall: "安装常驻 host",
    choiceInstallHint: "把 eta-host 装成本机的系统服务",
    choicesHelp: "按 1–{count}，或用 ↑↓ 加回车",

    addressLabel: "host 地址",
    tokenLabel: "令牌",
    addressHelp: "回车连接 · Tab 切换输入框 · Esc 返回",
    addressHelpNoBack: "回车连接 · Tab 切换输入框",
    checking: "正在检查 {url}…",
    needsToken: "这个 host 需要令牌。",
    badToken: "host 不接受这个令牌。",
    unreachableAddress: "{url} 上没有 host 回应。",
    invalidAddress: "这不是合法的地址。",

    hostMissingTitle: "找不到 eta-host",
    hostMissingTemporary:
      "启动临时 host 需要 eta-host。任选一种做法，再试一次：",
    hostMissingInstall: "安装常驻 host 需要 eta-host。任选一种做法，再试一次：",
    hostMissingEnv: "把环境变量 ETA_HOST_BIN 设为 eta-host 的路径",
    hostMissingPath: "把 eta-host 放进 PATH",
    hostMissingInstallPath: "装到 {path}",
    anyKeyBack: "按任意键返回",

    installRunning: "正在把 eta-host 装成系统服务…",
    installWaiting: "正在等服务启动…",
    installFailedTitle: "没能装好服务",
    installFailedRunning: "eta-host install-service 没有成功，它的输出：",
    installFailedWaiting: "服务装上了，但一直没有响应。eta-host 的输出：",
    installFailedWayOut:
      "在另一个终端或 tmux 里自己跑 eta-host，再选「连接常驻 host」。",

    reconnecting: "正在重新连接",
    reconnectingDetail: "{url} · 已过 {seconds} 秒",

    unauthorizedTitle: "{url} 上的 host 拒绝了令牌。",

    unreachableTitle: "无法连接",
    unreachableTemporaryFailed: "临时 host 没能启动。",
    unreachableTemporaryExited: "临时 host 退出了。",
    choiceUseTemporary: "改用临时 host",
    choiceUseTemporaryHint: "只用这一次，设定里仍是原来的地址",
    choiceChangeAddress: "更改地址",
    choiceQuit: "退出",

    quitHint: "再按一次 {key} 退出",
  },
});
