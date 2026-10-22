import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/pages/app-layout";

// The pages that keep the sidebar and the bottom tabs, at the top level: there is no
// second word to put in front of "tasks" or "routines", since the conversation list and
// the chat live at "/" and these two are simply the other two places to go.
export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
