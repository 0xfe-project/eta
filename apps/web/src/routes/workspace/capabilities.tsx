import { createFileRoute, redirect } from "@tanstack/react-router";

// The old capabilities page: GitHub and Grok moved to Settings → 连接. Keeps
// GitHub's return parameters, from links made before the move.
export const Route = createFileRoute("/workspace/capabilities")({
  beforeLoad: ({ location }) => {
    const params = new URLSearchParams(location.searchStr);
    params.set("settings", "connections");
    throw redirect({ href: `/?${params}` });
  },
});
