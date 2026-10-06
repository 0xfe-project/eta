import { PlusIcon } from "@phosphor-icons/react/Plus";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAnswerInteraction,
  useChat,
  useSendMessage,
  useStopReply,
} from "@/queries/chat";
import { AgentSwitcher } from "./agent-switcher";
import { ChatPanel } from "./chat-panel";
import { SettingsDialog } from "./settings-dialog";
import { useAgents } from "./use-agents";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspace } from "./workspace-state";
import type { WorkspaceView } from "./types";

function ChatNotice({
  error,
  empty,
  onCreate,
}: {
  error: Error | null;
  empty: boolean;
  onCreate: () => void;
}) {
  if (error)
    return (
      <p
        role="alert"
        className="px-1 pt-3 font-mono text-[13px] text-[var(--terminal-error)]"
      >
        无法加载对话：{error.message}
      </p>
    );
  if (!empty) return null;
  return (
    <div className="flex flex-col items-start gap-2 px-1 pt-4 font-mono text-[13px] text-[var(--terminal-muted)]">
      <p>还没有智能体。新建一个，就可以开始对话。</p>
      <Button size="sm" onClick={onCreate}>
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        新建智能体
      </Button>
    </div>
  );
}

export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const {
    workspace,
    draft,
    setDraft,
    mobilePanel,
    setMobilePanel,
    setSettings,
  } = useWorkspace();
  const chat = useChat();
  const { agents, current: selected } = useAgents();
  const sendMessage = useSendMessage();
  const stopReply = useStopReply();
  const answer = useAnswerInteraction();
  const createAgent = () =>
    setSettings({ open: true, section: "agents", creating: true });
  const onError = (error: Error) => toast.error(error.message);

  return (
    <div className="mx-auto flex h-dvh w-full min-h-0 flex-col bg-background px-4 pb-4 sm:px-6 lg:max-w-[calc(64rem+3rem)]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">axp.</h1>
        <div className="flex items-center gap-1">
          <AgentSwitcher />
          <SettingsDialog />
        </div>
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
            theme={workspace.sessionTheme}
            agents={agents}
            agentName={selected?.name}
            messages={chat.data?.messages ?? []}
            interactions={chat.data?.interactions ?? []}
            notice={
              <ChatNotice
                error={chat.error}
                empty={chat.isSuccess && agents.length === 0}
                onCreate={createAgent}
              />
            }
            draft={draft}
            onDraftChange={setDraft}
            onSend={(text) => {
              if (!selected) {
                createAgent();
                return;
              }
              sendMessage.mutate(
                { agentId: selected.id, text },
                { onSuccess: () => setDraft(""), onError },
              );
            }}
            onStop={(id) => stopReply.mutate(id, { onError })}
            onAnswer={(id, value) => answer.mutate({ id, value }, { onError })}
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
