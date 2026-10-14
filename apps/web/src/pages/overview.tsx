import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/workspace/app-shell";
import { Overview } from "@/components/workspace/overview";
import { SettingsButton } from "@/components/workspace/settings-dialog";

export function OverviewPage() {
  const { t: translateText } = useTranslation([
    "overview",
    "common",
    "navigation",
  ] as const);
  return (
    <>
      <PageHeader title={translateText("navigation:sections.overview")}>
        <SettingsButton />
      </PageHeader>
      <main id="main" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Overview />
      </main>
    </>
  );
}
