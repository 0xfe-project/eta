import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceWindow } from "@/pages/workspace-window";

export const Route = createFileRoute("/workspace")({
  component: WorkspaceWindow,
});
