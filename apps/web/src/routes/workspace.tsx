import { createFileRoute } from "@tanstack/react-router";
import { validateWorkspaceSearch } from "@/components/workspace/workspace-search";
import { WorkspaceWindow } from "@/pages/workspace-window";

export const Route = createFileRoute("/workspace")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceWindow,
});
