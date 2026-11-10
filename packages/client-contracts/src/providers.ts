/** Kinds with a built-in endpoint; the rest take one from the user. */
export const BUILTIN_PROVIDER_PRESETS = {
  "openai-codex": {
    name: "Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    logo: "openai.svg",
  },
  "kimi-coding": {
    name: "Kimi for Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    logo: "kimi.svg",
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    logo: "deepseek.svg",
  },
  "zai-coding-cn": {
    name: "GLM Coding Plan (CN)",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    logo: "zai.svg",
  },
  zai: {
    name: "GLM Coding Plan (Global)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    logo: "zai.svg",
  },
} as const;
