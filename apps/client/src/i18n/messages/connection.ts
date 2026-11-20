export const connectionMessages = {
  connectCannotReach: ["Can't reach this address", "无法连接此地址"],
  connectCheckAddress: [
    "Check the address, that the host is running, and that this computer can reach it.",
    "请检查地址是否正确、主机是否在运行，以及本机能否连接到主机。",
  ],
  connectWrongHost: ["That isn't an eta host", "这不是 Eta 主机"],
  connectCheckPort: ["Check the address and the port.", "请检查地址和端口。"],
  connectStartFailed: ["eta couldn't start the host", "Eta 无法启动主机"],
  connectFixOrSwitch: [
    "Fix it and retry, or connect to an existing host.",
    "修复后重试，或连接已有主机。",
  ],
  connectDownloadOffline: [
    "Can't reach the download server",
    "无法连接下载服务器",
  ],
  connectRetryNetwork: [
    "Check the network and retry, or connect to an existing host.",
    "检查网络后重试，或连接已有主机。",
  ],
  connectChecksumFailure: ["The download didn't check out", "下载校验失败"],
  connectChecksumDetails: [
    "It doesn't match the release's SHA256SUMS, so it was deleted without running. Retry downloads it again.",
    "下载内容与该版本的 SHA256SUMS 不匹配。文件已删除，未运行。重试会重新下载。",
  ],
  connectLostTitle: ["Lost the connection to the host", "主机连接已断开"],
  connectAgentsContinue: [
    "Agents keep running on the host. This window goes back by itself once it answers.",
    "智能体仍在主机上运行。主机恢复响应后，此窗口会自动返回。",
  ],
  connectScannerUnavailable: [
    "This device can't scan. Paste the connect link or fill in the form.",
    "此设备无法扫码。请粘贴连接链接，或填写表单。",
  ],
  cantReachThisHost: ["Can't reach this host", "无法连接此主机"],
  changeConnection: ["Change connection", "更改连接"],
  connecting: ["Connecting", "正在连接…"],
  connectToAnExistingHost: ["Connect to an existing host", "连接现有主机"],
  connectToOneHostReachEvery: [
    "Connect to one host, reach every machine.",
    "连接一台主机，即可访问所有机器。",
  ],
  downloadingTheHost: ["Downloading the host", "正在下载主机"],
  findingARelease: ["Finding a release…", "正在查找版本…"],
  getANewLinkFromThe: [
    "Get a new link from the host: Settings → Machines → Connect a phone.",
    "从主机获取新链接：设置 → 机器 → 连接手机。",
  ],
  hostAddressOrEtaLink: ["Host address or Eta link", "主机地址或 Eta 链接"],
  hostToken: ["Host token", "主机令牌"],
  hostUpdateInProgress: ["Host update in progress", "主机正在更新"],
  lastOnline: [
    " · Last online {{toLocaleTimeString}}",
    " · 上次在线 {{toLocaleTimeString}}",
  ],
  loadingEta: ["Loading Eta", "正在加载 Eta"],
  onlyTheFirstTimeAfterThis: [
    "Only the first time. After this the host updates on its own from Settings.",
    "仅首次需要下载。之后可在设置中更新主机。",
  ],
  runOnThisComputer: ["Run on this computer", "在本机运行"],
  startingTheNewVersion: ["Starting the new version", "正在启动新版本"],
  theHostAndItsDataStay: [
    "The host and its data stay on this computer.",
    "主机和数据保留在这台电脑上。",
  ],
  thePhoneIsOnlyAScreen: [
    "The phone is only a screen. Agents, memory and conversations stay on your machines.",
    "手机仅用于访问。智能体、记忆和对话数据仍保存在你的机器上。",
  ],
  theTwoKeepSeparateDataSwitching: [
    "The two keep separate data. Switching doesn't move anything.",
    "两台主机的数据各自保存，切换时不会迁移数据。",
  ],
  thisComputerIsOnlyAScreen: [
    "This computer is only a screen. Data stays on that host.",
    "此电脑仅用于访问，数据保留在主机上。",
  ],
  updatingTheHost: ["Updating the host", "正在更新主机"],
  updatingTo: ["Updating to {{to}}", "正在更新到 {{to}}"],
  useAnotherHost: ["Use another host", "使用其他主机"],
  whereShouldEtaRun: ["Where should eta run?", "你想在哪里运行 Eta？"],
  yourMachinesInYourPocket: [
    "Your machines, in your pocket.",
    "随身访问你的机器。",
  ],
} as const;
