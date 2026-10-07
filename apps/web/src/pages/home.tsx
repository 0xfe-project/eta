import { Workspace } from "@/components/workspace/workspace";
import { useWorkspaceView } from "@/components/workspace/workspace-search";

export function Home() {
  const [view, setView] = useWorkspaceView();
  return (
    <Workspace view={view} onViewChange={(value) => void setView(value)} />
  );
}
