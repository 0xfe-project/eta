export const onboardingMessages = {
  addASourceToContinue: ["Add a source to continue", "添加模型来源以继续"],
  agentsAreWhoYouTalkTo: [
    "Agents are who you talk to and hand tasks to.",
    "你可以与智能体对话，或把任务交给它们。",
  ],
  alreadyInstalled: [
    " · {{length}} already installed",
    " · {{length}} 个已安装",
  ],
  aSubscriptionAProviderApiKey: [
    "A subscription, a provider API key, or local models like Ollama.",
    "可以使用订阅、提供方 API 密钥，或 Ollama 等本地模型。",
  ],
  bindAModel: ["Bind a model", "绑定模型"],
  complete: ["Complete", "完成"],
  connectAModel: ["Connect a model", "绑定模型"],
  isConnected: ["{{names}} is connected.", "{{names}} 已连接。"],
  areConnected: ["{{names}} are connected.", "{{names}} 已连接。"],
  isInstalledSayHello: [
    "{{names}} is installed. Say hello in Chat.",
    "{{names}} 已安装。去聊天中打个招呼。",
  ],
  areInstalledSayHello: [
    "{{names}} are installed. Say hello in Chat.",
    "{{names}} 已安装。去聊天中打个招呼。",
  ],
  listAnd: ["{{items}} and {{last}}", "{{items}}和{{last}}"],
  listSeparator: [", ", "、"],
  getStarted: ["Get started", "开始使用"],
  gettingYourAgentsReady: ["Getting your agents ready.", "正在准备智能体。"],
  installAgents: ["Install agents", "安装智能体"],
  installAnAgent: ["Install an agent", "安装智能体"],
  installed: ["Installed", "已安装"],
  installFailed: ["Install failed: {{message}}", "安装失败：{{message}}"],
  installing: ["Installing…", "正在安装…"],
  isntReadyYet: ["{{hostname}} isn't ready yet", "{{hostname}} 尚未就绪"],
  loadingAgents: ["Loading agents…", "正在加载智能体…"],
  loadingEllipsis: ["Loading…", "加载中…"],
  sourceApiKey: ["API key", "API 密钥"],
  sourceModelCount: ["{{length}} models", "{{length}} 个模型"],
  nextStep: ["Next", "下一步"],
  nextInstallAgents: ["Next: Install agents", "下一步：安装智能体"],
  noPersonaCardsToInstall: [
    "No persona cards to install",
    "没有可安装的人格卡片",
  ],
  ofInstalled: [
    "{{length}} of {{total}} installed",
    "已安装 {{length}} / {{total}} 个",
  ],
  oneStepLeftOpenEtaOn: [
    "One step left. Open Eta on your computer to finish it.",
    "还有一步。请在电脑上打开 Eta 完成设置。",
  ],
  pickAFewToStart: ["Pick a few to start.", "先选择几个智能体。"],
  previousStep: ["Previous", "上一步"],
  retryInstall: ["Retry install", "重试安装"],
  setUpEta: ["Set up eta", "设置 Eta"],
  theHostDidntAnswerCheckYour: [
    "The host didn't answer. Check your connection to the host.",
    "主机没有响应，请检查与主机的连接。",
  ],
  thereIsNoProviderYetAdd: [
    "There is no provider yet. Add one so the host has something to run on.",
    "尚未配置提供方。请先添加一个供主机使用。",
  ],
  thisPageUpdatesByItselfWhen: [
    "This page updates by itself when you finish.",
    "完成后，此页会自动更新。",
  ],
  toInstall: [
    "{{length}} to install{{value2}}",
    "{{length}} 个待安装{{value2}}",
  ],
  twoShortStepsThenYourAgents: [
    "Two short steps, then your agents are ready to work.",
    "只需两步，即可让智能体开始工作。",
  ],
  twoStepsLeftOpenEtaOn: [
    "Two steps left. Open Eta on your computer to finish them.",
    "还有两步。请在电脑上打开 Eta 完成设置。",
  ],
  unableToLoadAgents: ["Agents didn't load", "智能体没加载出来"],
  welcomeToEta: ["Welcome to eta", "欢迎使用 Eta"],
  whichModelShouldYourAgentsUse: [
    "Which model should your agents use?",
    "智能体应该使用哪个模型？",
  ],
  whoWouldYouLikeToWork: [
    "Who would you like to work with?",
    "你想和哪些智能体一起工作？",
  ],
  youCanChangeAnyOfThis: [
    "You can change any of this later in Settings.",
    "之后可以在设置中修改这些选项。",
  ],
  youllLandInChatAsSoon: [
    "You'll land in Chat as soon as they're in place.",
    "安装完成后会自动进入聊天。",
  ],
  yourAgentsAreReady: ["Your agents are ready.", "智能体已就绪。"],
} as const;
