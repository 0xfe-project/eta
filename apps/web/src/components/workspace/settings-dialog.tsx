import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useNeedsAttention } from "@/queries/providers";
import { AttentionDot } from "./settings-nav";
import { SettingsPanels } from "./settings-panels";
import { settingsSections } from "./settings-sections";
import { useWorkspaceStore } from "./workspace-store";

/**
 * The sidebar's settings row: the same gear, in the same row every section wears.
 *
 * It used to be a `size="icon"` button with a label pushed into it, which is how Settings ended up at a
 * different type size from Tasks right beside it: an icon button's square is not a menu row's height,
 * inset or type. This is the menu row itself, so the two read as two of one thing and only their
 * order — the sections, then the door out of them — says which is which.
 */
export function SettingsMenuItem({ rail }: { rail: boolean }) {
  const { t: translateText } = useTranslation(["settings"] as const);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useNeedsAttention();
  const label = translateText("title");
  return (
    <SidebarMenuButton
      aria-label={
        attention
          ? `${label} · ${translateText("accessibility.needsAttention")}`
          : label
      }
      title={label}
      className={cn("relative overflow-visible text-sm", rail && "mx-auto")}
      onClick={() => setSettings((state) => ({ ...state, open: true }))}
    >
      <GearSixIcon aria-hidden="true" />
      {rail ? null : <span>{label}</span>}
      {attention ? (
        // In the rail the dot rides the gear's corner, exactly like the sections' counts do.
        <AttentionDot
          className={rail ? "absolute -top-0.5 -right-1" : "ml-auto"}
        />
      ) : null}
    </SidebarMenuButton>
  );
}

/**
 * `?settings=<section>` opens settings there, once: how links into a
 * settings section work. A section that does not exist opens the default one. The parameter is
 * dropped from the address.
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
    setSettings((state) => ({
      open: true,
      section: section?.value ?? state.section,
    }));
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
