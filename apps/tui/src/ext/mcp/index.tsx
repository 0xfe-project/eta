import type { Extension, SlashCommand } from "../../extensions/types";
import { McpLayer } from "./layer";
import { mcpMessages } from "./messages";

const mcp: SlashCommand = {
  name: "mcp",
  args: [],
  summary: {
    en: "List the agents' MCP servers, connect one or sign in to it",
    zh: "查看智能体的 MCP 服务器，连接或登录",
  },
  examples: [
    {
      input: "/mcp",
      summary: {
        en: "Sign in to a server that needs it",
        zh: "登录需要登录的服务器",
      },
    },
  ],
  requiredOps: [
    "mcp.connect",
    "mcp.reconnect",
    "mcp.login",
    "mcp.completeLogin",
  ],
  run: (ctx) => {
    ctx.openLayer((handle) => <McpLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "mcp",
  messages: mcpMessages,
  commands: [mcp],
};

export default extension;
