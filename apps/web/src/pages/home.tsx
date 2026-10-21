import { Workspace } from "@/components/workspace/workspace";
import { useWorkspaceView } from "@/components/workspace/workspace-search";
import { useOnboardRedirect } from "@/lib/onboard";

export function Home() {
  useOnboardRedirect();
  const [view, setView] = useWorkspaceView();
  return (
    <Workspace view={view} onViewChange={(value) => void setView(value)} />
  );
}
