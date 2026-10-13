import { createFileRoute } from "@tanstack/react-router";
import { validateWorkspaceSearch } from "@/components/workspace/workspace-search";
import { Home } from "@/pages/home";

export const Route = createFileRoute("/")({
  // Live data and local drafts load in the browser.
  ssr: false,
  validateSearch: validateWorkspaceSearch,
  component: Home,
});
