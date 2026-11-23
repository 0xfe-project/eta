import { openAgent } from "./plugins-composio-agent";
openAgent([
  { name: "@composio/gmail", slug: "gmail", state: "ready", enabled: true },
  { name: "@composio/ghost", slug: "ghost", state: "error", enabled: true },
]);
