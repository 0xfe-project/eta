// Adding a model source: the words of each step.
export const modelSourcesMessages = {
  addSourceConnectHint: [
    "Connecting lists the models, which is the check. Next: Models.",
    "连接会列出模型，这一步就是校验。下一步：选模型。",
  ],
  addSourceSignInHint: [
    "Sign in on the provider's page. This step ends by itself once you approve.",
    "在服务商的页面登录。批准后这一步会自己结束。",
  ],
  addSourceModelsHint: [
    "Tick the models agents may use.",
    "勾选智能体可以用的模型。",
  ],
  addSourceAccountHint: [
    "Nothing to choose: every model of the account is offered.",
    "不用选：账号的模型都会提供。",
  ],
  addSourceCustom: ["OpenAI-compatible API", "OpenAI 兼容接口"],
  addSourceKeyLabel: ["{{name}} API key", "{{name}} 的 API key"],
  addSourceKeyOptional: ["API key (optional)", "API key（可不填）"],
  addSourceUrl: ["URL", "网址"],
  addSourceProtocol: ["Protocol", "协议"],
  addSourceConnect: ["Connect", "连接"],
  addSourceConnecting: ["Connecting…", "正在连接…"],
  addSourceBack: ["Back", "上一步"],
  addSourceDone: ["Done", "完成"],
  addSourceGetKey: ["Get a key", "获取 key"],
  addSourceCommandCodeGetKey: ["Create a key in Studio", "去 Studio 创建 key"],
  addSourceCommandCodeNote: [
    "The Go plan has no API access; GOAT, Pro, Max, Team and Provider plans do. Claude models only speak the Anthropic protocol, which eta does not support yet.",
    "Go 计划没有 API 权限；GOAT、Pro、Max、Team 和 Provider 计划可以用。Claude 模型只走 Anthropic 协议，eta 暂不支持。",
  ],
  addSourceUnsupported: [
    "Not supported yet ({{protocol}} protocol)",
    "暂不支持（{{protocol}} 协议）",
  ],
  addSourceOtherEndpoint: [
    "Not supported yet (another endpoint)",
    "暂不支持（其他接口）",
  ],
  addSourceIncomplete: [
    "Not supported yet (incomplete data)",
    "暂不支持（资料不全）",
  ],
  addSourceNoModels: ["This source lists no models.", "这个来源没有列出模型。"],
  addSourceSelected: ["{{count}} selected", "已选 {{count}} 个"],
  addSourceAccountReady: [
    "{{name}} is connected, with {{count}} models.",
    "已连上 {{name}}，带来 {{count}} 个模型。",
  ],
  addSourceAccountReadyOne: [
    "{{name}} is connected, with 1 model.",
    "已连上 {{name}}，带来 1 个模型。",
  ],
  addSourceSearch: ["Search models", "搜索模型"],
  addSourceNoMatches: ["No matching models", "没有匹配的模型"],
  addSourceReasoning: ["Reasoning", "推理"],
  addSourceImages: ["Images", "图片"],
  addSourceDeprecated: ["Deprecated", "已弃用"],
  addSourceModelColumn: ["Model", "模型"],
  addSourceContextColumn: ["Context", "上下文"],
  addSourceStateColumn: ["State", "状态"],
  addSourceWorking: ["Working", "正常"],
  addSourceUnavailable: ["Unavailable", "不可用"],
  addSourceLoginInstructions: [
    "Open the authorization page, sign in and enter the code below.",
    "打开授权页面，登录后输入下面的验证码。",
  ],
  addSourceCodeLabel: ["Code {{code}}", "验证码 {{code}}"],
  addSourceCopyCode: ["Copy code", "复制验证码"],
  addSourceOpenAuthorization: ["Open authorization page", "打开授权页面"],
  addSourceWaiting: [
    "Waiting for authorization… expires in {{minutes}}:{{seconds}}",
    "等待授权… {{minutes}}:{{seconds}} 后过期",
  ],
  addSourceLoadingCode: ["Getting a code…", "正在获取验证码…"],
  addSourceLoginFailed: ["Sign-in failed. Try again.", "登录失败，请重试。"],
  addSourceRetry: ["Retry", "重试"],
  addSourceCodexHint: [
    "Sign in with your ChatGPT account. If the authorization page says device-code login isn't allowed, turn on device code authorization for Codex under Security in ChatGPT settings first.",
    "使用 ChatGPT 账号登录。如果授权页提示不允许设备码登录，请先在 ChatGPT 设置的“安全”中开启 Codex 的设备码授权。",
  ],
  addSourceXaiHint: [
    "Requires an xAI account that can use the Grok API (for example, a SuperGrok subscription).",
    "需要可以使用 Grok API 的 xAI 账号（例如 SuperGrok 订阅）。",
  ],
  addSourceGeminiHint: [
    "Create an API key in Google AI Studio, then enter it here.",
    "在 Google AI Studio 创建 API key 后填入。",
  ],
  addSourceDiscoveryInvalidConnection: [
    "Use an HTTP(S) base URL without credentials or query parameters.",
    "接口地址不对，请使用不含账号、密码或查询参数的 HTTP(S) 地址。",
  ],
  addSourceDiscoveryUnsupported: [
    "This source does not publish a model list.",
    "这个来源不提供模型列表。",
  ],
  addSourceDiscoveryNetwork: [
    "Cannot reach the model endpoint: {{reason}}. Check the URL, network, key and headers, then retry.",
    "无法连接模型接口：{{reason}}。请检查地址、网络、Key 和请求头后重试。",
  ],
  addSourceDiscoveryResponse: [
    "The model endpoint returned an invalid format: expected JSON with a data array. Check the URL and retry.",
    "模型接口返回格式不正确，应为包含 data 数组的 JSON。请检查地址后重试。",
  ],
  addSourceDiscoveryTimeout: [
    "Getting the model list timed out. Check the network and retry.",
    "获取模型列表超时，请检查网络后重试。",
  ],
  addSourceDiscoveryHttp: [
    "The model endpoint returned HTTP {{status}}. Check the URL, key, headers and access permissions, then retry.",
    "模型接口返回 HTTP {{status}}，请检查地址、Key、请求头和访问权限后重试。",
  ],
  addSourceDiscoveryConfigChanged: [
    "The config changed elsewhere. Go back to the list and open it again.",
    "配置在别处被改过，请回到列表重新打开。",
  ],
  addSourceDiscoveryUnreachable: [
    "Could not reach the model API. Check the URL and the network.",
    "连不上模型接口，检查网址和网络。",
  ],
  addSourceKeyRefused: [
    "Invalid key: the provider refused it.",
    "key 无效：服务商拒绝了它。",
  ],
  addSourceSaveConfigChanged: [
    "The config was changed elsewhere and has been read again. Take a look, then save once more.",
    "配置在别处被改过，已重新读取。看一下再保存一次。",
  ],
  addSourceSaveFailed: ["Cannot write config.json.", "写不进 config.json。"],
  addSourceSaveInvalid: [
    "config.json cannot be read. Fix the file first.",
    "config.json 读不出来，先修好这个文件。",
  ],
  addSourceDisconnected: [
    "The connection to the host was lost.",
    "与宿主的连接已断开。",
  ],
  addSourceTimeout: ["The host did not respond in time.", "宿主没有及时回应。"],
  llmProblemLoginExpired: [
    "The login has expired. Sign in again.",
    "登录已失效，请重新登录。",
  ],
  llmProblemInvalidApiKey: [
    "The API key is invalid. Enter it again.",
    "API key 无效，请重新填写。",
  ],
  llmProblemLoginStartFailed: [
    "Couldn't start the {{provider}} login. Try again later.",
    "无法发起 {{provider}} 登录，请稍后再试。",
  ],
  llmProblemLoginTimeout: [
    "Timed out. Enter the key again.",
    "已超时，请重新填写。",
  ],
  llmProblemDeviceCodeTimeout: [
    "The code expired. Start again.",
    "验证码已过期，请重新发起。",
  ],
  llmProblemLoginFailed: ["Login failed. Try again.", "登录失败，请重试。"],
  llmProblemLoginSaveFailed: [
    "Logged in, but the credentials couldn't be saved. Try again.",
    "登录成功但保存凭据失败，请重试。",
  ],
  llmProblemApiKeyRequired: ["Enter an API key.", "请填写 API key。"],
  llmProblemDuplicateApiKey: [
    "This API key has already been added.",
    "这个 API key 已经添加过了。",
  ],
  llmProblemKeyCheckUnavailable: [
    "Couldn't reach {{provider}} to check the API key. Try again later.",
    "暂时无法连接 {{provider}} 校验 API key，请稍后再试。",
  ],
  llmProblemGatewayUnavailable: [
    "The model service is unavailable right now. Try again later.",
    "模型服务暂时不可用，请稍后再试。",
  ],
  llmProblemUnknown: [
    "Unknown error ({{code}}): {{message}}",
    "未知错误（{{code}}）：{{message}}",
  ],
  modelReadOffline: [
    "Offline. The balance is read again once connected.",
    "离线中，连上后再读余额。",
  ],
} as const;
