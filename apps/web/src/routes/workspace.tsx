import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import {
  validateWorkspaceSearch,
  useWorkspaceView,
} from "@/components/workspace/workspace-search";
export const Route = createFileRoute("/workspace")({
  validateSearch: validateWorkspaceSearch,
  component: FullWindowWorkspace,
});
function FullWindowWorkspace() {
  const [view, setView] = useWorkspaceView();
  return (
    <main id="main" className="h-dvh">
      <WorkspacePanel
        fullWindow
        view={view}
        onViewChange={(value) => void setView(value)}
      />
    </main>
  );
}
