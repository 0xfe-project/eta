import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/workspace/app-shell";
import { useMemoryAgent } from "@/components/workspace/memory-nav";
import { MemoryView } from "@/components/workspace/memory-view";

export function MemoryPage() {
  const { t: translateText } = useTranslation([
    "memory",
    "common",
    "navigation",
  ] as const);
  const [agentId, setAgentId] = useMemoryAgent();
  return (
    <>
      <PageHeader title={translateText("navigation:sections.memory")} />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <MemoryView
            agentId={agentId ?? undefined}
            onAgentChange={(id) => void setAgentId(id)}
          />
        </div>
      </main>
    </>
  );
}
