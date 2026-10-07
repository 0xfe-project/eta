import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AgentSettings } from "./agent-settings";
import { useWorkspace, type SettingsSection } from "./workspace-state";

const sessionThemes = ["claude", "codex", "grok"] as const;
const sections: {
  value: SettingsSection;
  label: string;
  icon: typeof RobotIcon;
}[] = [
  { value: "agents", label: "智能体", icon: RobotIcon },
  { value: "appearance", label: "外观", icon: PaletteIcon },
];

function AppearanceSettings() {
  const { workspace, setWorkspace } = useWorkspace();
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">外观</h2>
      <fieldset className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <legend className="sr-only">会话外观</legend>
        <span aria-hidden="true" className="text-sm font-medium">
          会话外观
        </span>
        <div className="w-fit max-w-full bg-muted p-1">
          <div className="relative isolate grid grid-cols-3">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-background shadow-xs transition-transform motion-reduce:transition-none"
              style={{
                transform: `translateX(${sessionThemes.indexOf(workspace.sessionTheme) * 100}%)`,
              }}
            />
            {sessionThemes.map((theme) => (
              <label
                key={theme}
                className="relative cursor-pointer px-3 py-1.5 text-center text-sm capitalize text-muted-foreground transition-colors has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name="session-theme"
                  value={theme}
                  checked={workspace.sessionTheme === theme}
                  onChange={() =>
                    setWorkspace((state) => ({
                      ...state,
                      sessionTheme: theme,
                    }))
                  }
                  className="sr-only"
                />
                {theme}
              </label>
            ))}
          </div>
        </div>
      </fieldset>
    </div>
  );
}

export function SettingsDialog() {
  const { settings, setSettings } = useWorkspace();

  return (
    <Dialog
      open={settings.open}
      onOpenChange={(open) => setSettings((state) => ({ ...state, open }))}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="设置" title="设置">
          <GearSixIcon aria-hidden="true" />
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
            className="flex shrink-0 gap-1 bg-muted/40 p-2 sm:w-44 sm:flex-col"
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
                    "bg-background font-medium text-foreground shadow-xs",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </button>
            ))}
          </nav>
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            {settings.section === "agents" ? (
              <AgentSettings />
            ) : (
              <AppearanceSettings />
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
