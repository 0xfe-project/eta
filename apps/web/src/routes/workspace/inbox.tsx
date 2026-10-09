import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "@/pages/inbox";

export const Route = createFileRoute("/workspace/inbox")({
  component: InboxPage,
});
