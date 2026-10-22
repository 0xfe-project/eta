import { createFileRoute, redirect } from "@tanstack/react-router";

// Anything that is not a page this app still has — the old `/workspace/tasks` links, the
// inbox and memory pages before them, a typo — goes back to the conversation list rather
// than to a not-found screen the person can do nothing with.
export const Route = createFileRoute("/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: {}, replace: true });
  },
});
