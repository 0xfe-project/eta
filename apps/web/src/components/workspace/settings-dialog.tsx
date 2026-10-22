import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useNeedsAttention } from "@/queries/providers";
import { AttentionDot } from "./settings-nav";
import { SettingsPanels } from "./settings-panels";
import { settingsSections } from "./settings-sections";
import { useWorkspaceStore } from "./workspace-store";

/** Opens settings; the dot marks accounts the user has to act on. */
export function SettingsButton({
  className,
  withLabel = false,
}: {
  className?: string;
  /** The word beside the gear, for a place that lists what things are. */
  withLabel?: boolean;
}) {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useNeedsAttention();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={
        attention
          ? translateText("accessibility.needsAttention")
          : translateText("title")
      }
      title={translateText("title")}
      className={cn("relative", className)}
      onClick={() => setSettings((state) => ({ ...state, open: true }))}
    >
      <GearSixIcon aria-hidden="true" />
      {withLabel ? (
        <span className="truncate">{translateText("title")}</span>
      ) : null}
      {attention ? (
        <AttentionDot className="absolute top-1.5 right-1.5" />
      ) : null}
    </Button>
  );
}

/**
 * `?settings=<section>` opens settings there, once: how links into a
 * settings section work. The parameter is dropped from the address.
 */
function useSettingsLink() {
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("settings")) return;
    const section = settingsSections.find(
      ({ value }) => value === url.searchParams.get("settings"),
    );
    url.searchParams.delete("settings");
    window.history.replaceState(window.history.state, "", url);
    if (section) setSettings({ open: true, section: section.value });
  }, [setSettings]);
}

/**
 * Settings over whatever is on screen, opened by the wide window's gear. On a phone the fourth
 * tab goes to the page instead (`/settings`): a dialog covering the whole screen is a page with a
 * shadow, and the phone had no way back out of it that the browser knows about.
 */
export function SettingsDialog() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const settings = useWorkspaceStore((s) => s.settings);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  useSettingsLink();

  return (
    <Dialog
      open={settings.open}
      onOpenChange={(open) => setSettings((state) => ({ ...state, open }))}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(36rem,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <DialogHeader className="shrink-0 border-b p-3 pr-12">
          <DialogTitle className="text-base">
            {translateText("title")}
          </DialogTitle>
        </DialogHeader>
        {/* eta-old's settings: a 196px rail of sections and a column of rows beside it. */}
        <SettingsPanels
          value={settings.section}
          onChange={(section) =>
            setSettings((state) => ({ ...state, section }))
          }
        />
      </DialogContent>
    </Dialog>
  );
}
