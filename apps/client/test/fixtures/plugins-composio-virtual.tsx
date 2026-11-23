import { openInstalled } from "./plugins-composio-installed";
openInstalled("desktop", "two", "ok", [
  { name: "@composio/gmail", slug: "gmail", state: "ready" },
  { name: "@composio/ghost", slug: "ghost", state: "error" },
]);
