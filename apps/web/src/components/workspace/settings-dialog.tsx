import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSettings } from "@/components/language-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/use-theme";
import { elementPickerDefault, setElementPicker } from "@/lib/element-picker";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useGitHubMounted } from "@/queries/github";
import { useNeedsAttention } from "@/queries/providers";
import { AgentSettings } from "./agent-settings";
import { ApprovalSettings } from "./approval-settings";
import { BundleSettings } from "./bundle-settings";
import { ConnectionSettings } from "./connection-settings";
import { ArchivedGroups } from "./groups";
import { MachineSettings } from "./machine-settings";
import { McpSettings } from "./mcp-settings";
import { ProviderSettings } from "./provider-settings";
import { AttentionDot, SettingsNav } from "./settings-nav";
import { settingsSections, useSettingsAttention } from "./settings-sections";
import { useWorkspaceStore } from "./workspace-store";

const colorModes = [
  {
    value: "system",
    get label() {
      return translate("settings:appearance.system");
    },
  },
  {
    value: "light",
    get label() {
      return translate("settings:appearance.light");
    },
  },
  {
    value: "dark",
    get label() {
      return translate("settings:appearance.dark");
    },
  },
] as const;
function AppearanceSettings() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <div className="settings-heading">
        <h2>{translateText("sections.appearance")}</h2>
        <p>{translateText("appearance.description")}</p>
      </div>
      {/* Rows, not cards: a label on the left, its control on the right, one decision per line. */}
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{translateText("appearance.colorMode")}</div>
          <p>{translateText("appearance.colorModeHint")}</p>
        </div>
        <div className="settings-control settings-inline">
          {colorModes.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={theme === choice.value}
              onClick={() => setTheme(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{translateText("appearance.language")}</div>
        </div>
        <div className="settings-control">
          <LanguageSettings />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{translateText("appearance.elementPicker")}</div>
          <p>{translateText("appearance.elementPickerHint")}</p>
        </div>
        <div className="settings-control">
          <Switch
            id="react-grab"
            aria-label={translateText("appearance.elementPicker")}
            checked={workspace.reactGrab ?? elementPickerDefault()}
            onCheckedChange={(reactGrab) => {
              setWorkspace((state) => ({ ...state, reactGrab }));
              void setElementPicker(reactGrab);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Opens settings; the dot marks accounts the user has to act on. */
export function SettingsButton({ className }: { className?: string }) {
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

export function SettingsDialog() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const settings = useWorkspaceStore((s) => s.settings);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useSettingsAttention();
  const githubMounted = useGitHubMounted();
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
        <div className="settings-layout">
          <SettingsNav
            label={translateText("accessibility.sections")}
            sections={settingsSections
              // No GitHub plugin on the host: nothing to connect.
              .filter(
                (section) => section.value !== "connections" || githubMounted,
              )
              .map((section) => ({
                ...section,
                attention: attention[section.value],
                hint: translateText("accessibility.accountsNeedAttention"),
              }))}
            value={settings.section}
            onChange={(section) =>
              setSettings((state) => ({ ...state, section }))
            }
          />
          <section className="settings-content">
            {settings.section === "agents" ? (
              <AgentSettings />
            ) : settings.section === "providers" ? (
              <ProviderSettings />
            ) : settings.section === "approvals" ? (
              <ApprovalSettings />
            ) : settings.section === "machines" ? (
              <MachineSettings />
            ) : settings.section === "bundles" ? (
              <BundleSettings />
            ) : settings.section === "connections" ? (
              <ConnectionSettings />
            ) : settings.section === "mcp" ? (
              <McpSettings />
            ) : settings.section === "archived" ? (
              <ArchivedGroups />
            ) : (
              <AppearanceSettings />
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
