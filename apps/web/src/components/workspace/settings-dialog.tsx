import type { WorkspaceState } from "./workspace-store";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { elementPickerDefault, setElementPicker } from "@/lib/element-picker";
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
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
const fontFields = [
  { key: "fontSans", label: "界面字体", placeholder: "Geist" },
  { key: "fontMono", label: "等宽字体", placeholder: "Geist Mono" },
] as const satisfies {
  key: keyof WorkspaceState;
  label: string;
  placeholder: string;
}[];
/** OpenObserve, proxied by the edge gateway under /observe. */
function LogSettings() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">日志</h2>
      <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0 text-sm">
          <p className="font-medium">OpenObserve</p>
          <p className="text-muted-foreground">登录账号 root@axp.local</p>
        </div>
        <Button asChild variant="outline" size="sm" className="w-fit">
          <a href="/observe/web/" target="_blank" rel="noreferrer">
            打开
            <ArrowSquareOutIcon aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
  );
}

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
              className="relative cursor-pointer px-3 py-1.5 text-center text-sm text-muted-foreground transition-colors has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
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
  const workspace = useWorkspaceStore((s) => s.workspace);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const { theme = "system", setTheme } = useTheme();
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">外观</h2>
      <Segmented
        label="颜色模式"
        name="color-mode"
        options={colorModes}
        value={theme as (typeof colorModes)[number]["value"]}
        onChange={setTheme}
      />
      {fontFields.map(({ key, label, placeholder }) => (
        <div
          key={key}
          className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_16rem] md:items-center"
        >
          <label htmlFor={key} className="text-sm font-medium">
            {label}
          </label>
          <Input
            id={key}
            value={workspace[key] ?? ""}
            placeholder={placeholder}
            maxLength={200}
            spellCheck={false}
            onChange={(e) =>
              setWorkspace((state) => ({
                ...state,
                [key]: e.target.value || undefined,
              }))
            }
          />
        </div>
      ))}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0 text-sm">
          <label htmlFor="react-grab" className="font-medium">
            圈选元素
          </label>
          <p id="react-grab-hint" className="text-muted-foreground">
            打开后可以圈选元素并复制组件和源码位置。
          </p>
        </div>
        <Switch
          id="react-grab"
          aria-describedby="react-grab-hint"
          checked={workspace.reactGrab ?? elementPickerDefault()}
          onCheckedChange={(reactGrab) => {
            setWorkspace((state) => ({ ...state, reactGrab }));
            void setElementPicker(reactGrab);
          }}
        />
      </div>
    </div>
  );
}

/** Opens settings; the dot marks accounts the user has to act on. */
export function SettingsButton({ className }: { className?: string }) {
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useNeedsAttention();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={attention ? "设置（有账号需要处理）" : "设置"}
      title="设置"
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
          <DialogTitle className="text-base">设置</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <SettingsNav
            label="设置分类"
            sections={settingsSections.map((section) => ({
              ...section,
              attention: attention[section.value],
              hint: "有账号需要处理",
            }))}
            value={settings.section}
            onChange={(section) =>
              setSettings((state) => ({ ...state, section }))
            }
          />
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
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
            ) : settings.section === "logs" ? (
              <LogSettings />
            ) : (
              <AppearanceSettings />
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
