import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/workspace/app-shell";
import { RuntimesView } from "@/components/workspace/runtimes-view";

export function RuntimesPage() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  return (
    <>
      <PageHeader title={translateText("sections.runtimes")} />
      <main
        id="main"
        tabIndex={-1}
        className="min-h-0 w-full flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[42.5rem] px-4 py-6 sm:px-8">
          <RuntimesView />
        </div>
      </main>
    </>
  );
}
