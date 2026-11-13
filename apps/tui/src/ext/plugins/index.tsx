import type { Extension, SlashCommand } from "../../extensions/types";
import { PluginsLayer } from "./layer";
import { pluginsMessages } from "./messages";

const plugins: SlashCommand = {
  name: "plugins",
  args: [],
  summary: {
    en: "List the host's plugins and turn one on or off for agents",
    zh: "查看 host 上的插件，给智能体启用或停用",
  },
  examples: [
    {
      input: "/plugins",
      summary: {
        en: "Choose which agents use a plugin",
        zh: "选哪些智能体用某个插件",
      },
    },
  ],
  requiredOps: ["agents.update"],
  run: (ctx) => {
    ctx.openLayer((handle) => <PluginsLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "plugins",
  messages: pluginsMessages,
  commands: [plugins],
};

export default extension;
