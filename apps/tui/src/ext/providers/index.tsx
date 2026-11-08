import type { Extension, SlashCommand } from "../../extensions/types";
import { providersMessages } from "./messages";
import { ProvidersLayer } from "./providers-layer";

const providersCommand: SlashCommand = {
  name: "providers",
  args: [],
  summary: {
    en: "See and connect the model gateway's subscription accounts and API keys",
    zh: "查看与连接模型网关的订阅账号和 API key",
  },
  examples: [
    {
      input: "/providers",
      summary: {
        en: "Connect a Codex, Grok or Google AI Studio account",
        zh: "连接 Codex、Grok 或 Google AI Studio 账号",
      },
    },
  ],
  // The gateway is an optional plugin: without it the layer says so instead of refusing.
  requiredOps: [],
  run: (ctx) => {
    ctx.openLayer((handle) => <ProvidersLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "providers",
  messages: providersMessages,
  commands: [providersCommand],
};

export default extension;
