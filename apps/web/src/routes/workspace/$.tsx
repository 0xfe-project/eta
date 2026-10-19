import { createFileRoute, redirect } from "@tanstack/react-router";

// Pages that no longer exist (inbox, memory, more) and anything else under /workspace that is not
// tasks or routines: back to the conversation list.
export const Route = createFileRoute("/workspace/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: {}, replace: true });
  },
});
