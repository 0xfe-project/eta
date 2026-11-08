import type { Extension, SlashCommand } from "../../extensions/types";
import { GitHubLayer } from "./layer";
import { githubMessages } from "./messages";

const github: SlashCommand = {
  name: "github",
  args: [],
  summary: {
    en: "Show where the GitHub App stands, refresh it or authorize it",
    zh: "查看 GitHub App 的状态，刷新或授权",
  },
  examples: [
    {
      input: "/github",
      summary: {
        en: "See which accounts the App is installed on",
        zh: "看 App 装在哪些账号",
      },
    },
  ],
  // `github` is an optional plugin: the layer says so when the host did not mount it, instead of
  // the command being refused as too new for the host.
  requiredOps: [],
  run: (ctx) => {
    ctx.openLayer((handle) => <GitHubLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "github",
  messages: githubMessages,
  commands: [github],
};

export default extension;
