import { createFileRoute } from "@tanstack/react-router";
import { AppSkeleton } from "@/components/app-skeleton";
import { validateWorkspaceSearch } from "@/components/workspace/workspace-search";
import { Home } from "@/pages/home";

export const Route = createFileRoute("/")({
  validateSearch: validateWorkspaceSearch,
  component: Home,
  // Kept in this file by the code splitter, so it is here before the workspace's chunk is.
  pendingComponent: () => <AppSkeleton content="chat" />,
});
