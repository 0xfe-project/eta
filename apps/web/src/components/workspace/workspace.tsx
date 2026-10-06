import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChatPanel } from "./chat-panel";
import { SettingsDialog } from "./settings-dialog";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspace } from "./workspace-state";
import type { WorkspaceView } from "./types";
export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const {
    workspace,
    setWorkspace,
    draft,
    setDraft,
    mobilePanel,
    setMobilePanel,
  } = useWorkspace();
  return (
    <div className="mx-auto flex h-dvh w-full min-h-0 flex-col bg-background lg:max-w-[64rem]">
      <header className="flex h-14 shrink-0 items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">axp.</h1>
        <SettingsDialog />
      </header>
      <div className="grid grid-cols-2 md:hidden" aria-label="工作区面板">
        <Button
          variant="ghost"
          className={cn("h-10", mobilePanel === "chat" && "bg-muted")}
          onClick={() => setMobilePanel("chat")}
          aria-pressed={mobilePanel === "chat"}
        >
          对话
        </Button>
        <Button
          variant="ghost"
          className={cn("h-10", mobilePanel === "workspace" && "bg-muted")}
          onClick={() => setMobilePanel("workspace")}
          aria-pressed={mobilePanel === "workspace"}
        >
          工作区
        </Button>
      </div>
      <main
        id="main"
        className="isolate grid min-h-0 flex-1 gap-4 md:grid-cols-2 md:gap-5"
      >
        <div
          className={cn(
            "min-h-0 min-w-0",
            mobilePanel === "workspace" && "hidden md:block",
          )}
        >
          <ChatPanel
            draft={draft}
            onDraftChange={setDraft}
            theme={workspace.sessionTheme}
            messages={workspace.messages}
            onSend={(content) =>
              setWorkspace((state) => ({
                ...state,
                messages: [
                  ...state.messages,
                  { id: crypto.randomUUID(), content },
                ],
              }))
            }
          />
        </div>
        <WorkspacePanel
          view={view}
          onViewChange={onViewChange}
          className={mobilePanel === "chat" ? "hidden md:flex" : undefined}
        />
      </main>
    </div>
  );
}
