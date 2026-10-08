import type { SettingsSection, WorkspaceState } from "./workspace-store";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ChartLineIcon } from "@phosphor-icons/react/ChartLine";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useNeedsAttention } from "@/queries/llm";
import { AgentSettings } from "./agent-settings";
import { ComputerSettings } from "./computer-settings";
import { ProviderSettings } from "./provider-settings";
import { useWorkspaceStore } from "./workspace-store";

const colorModes = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;
const sessionThemes = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "grok", label: "Grok" },
] as const;
const fontFields = [
  { key: "fontSans", label: "界面字体", placeholder: "Geist" },
  { key: "fontMono", label: "等宽字体", placeholder: "Geist Mono" },
] as const satisfies {
  key: keyof WorkspaceState;
  label: string;
  placeholder: string;
}[];
const sections: {
  value: SettingsSection;
  label: string;
  icon: typeof RobotIcon;
}[] = [
  { value: "agents", label: "智能体", icon: RobotIcon },
  { value: "providers", label: "模型服务", icon: PlugsConnectedIcon },
  { value: "computers", label: "远程电脑", icon: DesktopIcon },
  { value: "appearance", label: "外观", icon: PaletteIcon },
  { value: "logs", label: "日志", icon: ChartLineIcon },
];

/** OpenObserve, proxied by the edge gateway under /observe. */
function LogSettings() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">日志</h2>
      <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
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
    <fieldset className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
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
      <Segmented
        label="会话外观"
        name="session-theme"
        options={sessionThemes}
        value={workspace.sessionTheme}
        onChange={(sessionTheme) =>
          setWorkspace((state) => ({ ...state, sessionTheme }))
        }
      />
      {fontFields.map(({ key, label, placeholder }) => (
        <div
          key={key}
          className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-center"
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
    </div>
  );
}

/** Marks places that lead to accounts the user has to act on. */
function AttentionDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 bg-destructive", className)}
    />
  );
}

export function SettingsDialog() {
  const settings = useWorkspaceStore((s) => s.settings);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useNeedsAttention();

  return (
    <Dialog
      open={settings.open}
      onOpenChange={(open) => setSettings((state) => ({ ...state, open }))}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={attention ? "设置（有账号需要处理）" : "设置"}
          title="设置"
          className="relative"
        >
          <GearSixIcon aria-hidden="true" />
          {attention ? (
            <AttentionDot className="absolute top-1.5 right-1.5" />
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(36rem,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <DialogHeader className="shrink-0 border-b p-3 pr-12">
          <DialogTitle className="text-base">设置</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="设置分类"
            className="flex shrink-0 gap-1 border-b p-2 sm:w-44 sm:flex-col sm:border-r sm:border-b-0"
          >
            {sections.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-current={settings.section === value ? "page" : undefined}
                onClick={() =>
                  setSettings((state) => ({ ...state, section: value }))
                }
                className={cn(
                  "flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground transition-colors duration-[60ms] ease-linear outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                  settings.section === value &&
                    "bg-accent font-medium text-accent-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
                {value === "providers" && attention ? (
                  <>
                    <AttentionDot className="ml-auto" />
                    <span className="sr-only">（有账号需要处理）</span>
                  </>
                ) : null}
              </button>
            ))}
          </nav>
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            {settings.section === "agents" ? (
              <AgentSettings />
            ) : settings.section === "providers" ? (
              <ProviderSettings />
            ) : settings.section === "computers" ? (
              <ComputerSettings />
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
