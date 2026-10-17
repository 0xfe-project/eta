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
import { useNeedsAttention } from "@/queries/llm";
import { AgentSettings } from "./agent-settings";
import { BundleSettings } from "./bundle-settings";
import { ComputerSettings } from "./computer-settings";
import { ConnectionSettings } from "./connection-settings";
import { ArchivedGroups } from "./groups";
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
/** A row of mutually exclusive choices with a sliding selection. */
function Segmented<T extends string>({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const index = options.findIndex((option) => option.value === value);
  return (
    <fieldset className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="text-sm font-medium">
        {label}
      </span>
      <div className="w-fit max-w-full bg-muted p-1">
        <div
          className="relative isolate grid"
          style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
        >
          {index >= 0 ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 border border-transparent bg-background shadow-xs transition-transform motion-reduce:transition-none dark:border-input dark:bg-input/30"
              style={{
                width: `${100 / options.length}%`,
                transform: `translateX(${index * 100}%)`,
              }}
            />
          ) : null}
          {options.map((option) => (
            <label
              key={option.value}
              className="relative cursor-pointer px-3 py-1.5 text-center text-sm text-muted-foreground has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

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
 * `?settings=<section>` opens settings there, once: how GitHub's redirects
 * and old links reach 连接. The parameter is dropped from the address.
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
            sections={settingsSections.map((section) => ({
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
            ) : settings.section === "bundles" ? (
              <BundleSettings />
            ) : settings.section === "providers" ? (
              <ProviderSettings />
            ) : settings.section === "connections" ? (
              <ConnectionSettings />
            ) : settings.section === "computers" ? (
              <ComputerSettings />
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
