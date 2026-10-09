import { PageHeader } from "@/components/workspace/app-shell";
import { CapabilitiesView } from "@/components/workspace/capabilities-view";

export function CapabilitiesPage() {
  return (
    <>
      <PageHeader title="能力" />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <CapabilitiesView />
        </div>
      </main>
    </>
  );
}
