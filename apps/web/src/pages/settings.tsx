import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/workspace/app-shell";
import { SettingsPanels } from "@/components/workspace/settings-panels";
import { useSettingsSection } from "@/components/workspace/settings-route";

/**
 * Settings as a page: the phone's fourth tab lands here, back out of it, and a reload comes
 * back to the same section. The same body fills the wide window's dialog, opened by the gear in
 * the sidebar — one rail of sections, one set of panels, two frames.
 */
export function SettingsPage() {
  const { t: translateText } = useTranslation([
    "settings",
    "common",
    "navigation",
  ] as const);
  const [search, setSearch] = useSettingsSection();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  // Back to wherever it was entered from, which the tab cannot know. Opened in a tab of its own
  // there is nothing behind it, so it goes home instead of doing nothing.
  const back = () => {
    if (canGoBack) return void router.history.back();
    void router.navigate({ to: "/", search: {} });
  };
  return (
    <>
      <PageHeader
        title={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("navigation:actions.back")}
              title={translateText("navigation:actions.back")}
              className="-ml-2"
              onClick={back}
            >
              <ArrowLeftIcon aria-hidden="true" />
            </Button>
            <span className="truncate">{translateText("title")}</span>
          </>
        }
      />
      <main
        id="main"
        className="mx-auto flex min-h-0 w-full max-w-content flex-1"
      >
        <SettingsPanels
          className="settings-page"
          value={search.section ?? "agents"}
          onChange={(section) => void setSearch({ section })}
        />
      </main>
    </>
  );
}
