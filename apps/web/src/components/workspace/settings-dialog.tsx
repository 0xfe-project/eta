import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspace } from "./workspace-state";

const sessionThemes = ["claude", "codex", "grok"] as const;

export function SettingsDialog() {
  const { workspace, setWorkspace } = useWorkspace();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          title="设置"
        >
          <GearSixIcon aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(36rem,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <DialogHeader className="shrink-0 p-3 pr-12">
          <DialogTitle className="text-base">设置</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="shrink-0 bg-muted/40 p-2 sm:w-48">
            <nav aria-label="设置分类">
              <a
                href="#agent-settings"
                aria-current="location"
                className="flex items-center gap-2 bg-accent px-2 py-2 text-sm font-medium text-accent-foreground"
              >
                <TerminalWindowIcon aria-hidden="true" className="size-4" />
                智能体
              </a>
            </nav>
          </aside>
          <section
            id="agent-settings"
            aria-label="智能体设置"
            className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto p-3"
          >
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
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
