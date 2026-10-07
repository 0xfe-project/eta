import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { useWorkspaceView } from "@/components/workspace/workspace-search";

export function WorkspaceWindow() {
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
