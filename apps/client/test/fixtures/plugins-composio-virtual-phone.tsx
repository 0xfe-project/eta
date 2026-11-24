import { openInstalled } from "./plugins-composio-installed";
openInstalled("phone", "two", "ok", [
  { name: "@composio/gmail", slug: "gmail", state: "ready" },
  { name: "@composio/ghost", slug: "ghost", state: "error" },
]);
