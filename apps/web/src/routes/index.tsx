import { createFileRoute } from "@tanstack/react-router";
import { Workspace } from "@/components/workspace/workspace";
import {
  useWorkspaceView,
  validateWorkspaceSearch,
} from "@/components/workspace/workspace-search";
export const Route = createFileRoute("/")({
  validateSearch: validateWorkspaceSearch,
  component: Home,
});
function Home() {
  const [view, setView] = useWorkspaceView();
  return (
    <Workspace view={view} onViewChange={(value) => void setView(value)} />
  );
}
