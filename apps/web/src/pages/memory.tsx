import { Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/workspace/app-shell";
import { useMemoryAgent } from "@/components/workspace/memory-nav";
import { MemoryView } from "@/components/workspace/memory-view";
import { useMemoryMounted } from "@/queries/memory";
import { useWireState } from "@/queries/wire";

export function MemoryPage() {
  const { t: translateText } = useTranslation([
    "memory",
    "common",
    "navigation",
  ] as const);
  const [agentId, setAgentId] = useMemoryAgent();
  const mounted = useMemoryMounted();
  const connecting = useWireState((state) => state.status === "connecting");
  // Without a memory sidecar the page does not exist: a direct address goes back to the inbox.
  if (!mounted)
    return connecting ? null : <Navigate to="/workspace/inbox" replace />;
  return (
    <>
      <PageHeader title={translateText("navigation:sections.memory")} />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-content px-4 py-6 sm:px-6">
          <MemoryView
            agentId={agentId ?? undefined}
            onAgentChange={(id) => void setAgentId(id)}
          />
        </div>
      </main>
    </>
  );
}
