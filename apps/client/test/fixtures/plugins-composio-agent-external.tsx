import { openAgent } from "./plugins-composio-agent";
openAgent(
  [{ name: "@composio/gmail", slug: "gmail", state: "ready", enabled: true }],
  { runtime: "acp.claude" },
);
