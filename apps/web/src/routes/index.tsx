import { createFileRoute } from "@tanstack/react-router";
import { validateWorkspaceSearch } from "@/components/workspace/workspace-search";
import { Home } from "@/pages/home";

export const Route = createFileRoute("/")({
  validateSearch: validateWorkspaceSearch,
  component: Home,
});
