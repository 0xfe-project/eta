import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/workspace/app-shell";
import { useMemoryAgent } from "@/components/workspace/memory-nav";
import { MemoryView } from "@/components/workspace/memory-view";
import { capabilities } from "@/lib/capabilities";

export function MemoryPage() {
  const { t: translateText } = useTranslation([
    "memory",
    "common",
    "navigation",
  ] as const);
  const [agentId, setAgentId] = useMemoryAgent();
  // The memory bundle's service is not on this host yet (P3.4): a direct URL still renders
  // something true, rather than a page that loads forever behind a hidden navigation entry.
  if (!capabilities.memory)
    return (
      <>
        <PageHeader title={translateText("navigation:sections.memory")} />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-content px-4 py-6 sm:px-6">
            <p className="text-sm text-muted-foreground">
              {translateText("memory:notOnThisHost")}
            </p>
          </div>
        </main>
      </>
    );
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
