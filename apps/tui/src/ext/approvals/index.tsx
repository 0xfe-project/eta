import type { Extension, SlashCommand } from "../../extensions/types";
import { ApprovalsLayer } from "./layer";
import { approvalsMessages } from "./messages";

const approvals: SlashCommand = {
  name: "approvals",
  args: [],
  summary: {
    en: "List the tools that ask before they run, and add or remove one",
    zh: "查看运行前要先问过的工具，添加或删除",
  },
  examples: [
    {
      input: "/approvals",
      summary: {
        en: "Make a tool ask for approval before every call",
        zh: "让某个工具每次调用前先问过",
      },
    },
  ],
  requiredOps: ["inbox.setApprovals"],
  run: (ctx) => {
    ctx.openLayer((handle) => <ApprovalsLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "approvals",
  messages: approvalsMessages,
  commands: [approvals],
};

export default extension;
