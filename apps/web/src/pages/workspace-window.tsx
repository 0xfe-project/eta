import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { useWorkspaceView } from "@/components/workspace/workspace-search";
import { useChat } from "@/queries/chat";

export function WorkspaceWindow() {
  const [view, setView] = useWorkspaceView();
  // Keeps the chat snapshot live (over SSE) for the confirmation tab.
  useChat();
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
