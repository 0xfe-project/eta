/** Kinds with a built-in endpoint; the rest take one from the user. */
export const BUILTIN_PROVIDER_PRESETS = {
  // Eta's own gateway: OpenAI Chat Completions with a model list at `/models`, one key for all of
  // it. Its models are other makers' (`claude-sonnet-5`), so their facts are found by model id.
  eta: {
    name: "Eta Token Plan",
    baseUrl: "https://eta.0xfe.tech/v1",
  },
  "openai-codex": {
    name: "Codex",
    baseUrl: "https://chatgpt.com/backend-api",
  },
  "kimi-coding": {
    name: "Kimi for Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
  },
  "zai-coding-cn": {
    name: "GLM Coding Plan (CN)",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  },
  zai: {
    name: "GLM Coding Plan (Global)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
  },
  // OpenCode's gateways serve several protocols; the base URL is the OpenAI one (Chat
  // Completions and Responses), and each model says which of the two it speaks.
  opencode: {
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/inference/openai/v1",
  },
  "opencode-go": {
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
  },
} as const;

/** Where an Eta Token Plan key is made. */
export const ETA_TOKEN_PLAN_KEYS_URL =
  "https://eta.0xfe.tech/app/dashboard?tab=keys";
