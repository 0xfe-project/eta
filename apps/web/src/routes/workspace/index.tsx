import { createFileRoute, redirect } from "@tanstack/react-router";

// The full-window workspace opens on its first section.
export const Route = createFileRoute("/workspace/")({
  beforeLoad: () => {
    throw redirect({ to: "/workspace/tasks" });
  },
});
