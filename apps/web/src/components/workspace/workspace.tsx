import type { WorkspaceView } from "./types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAnswerInteraction,
  useChat,
  useSendMessage,
  useStopReply,
} from "@/queries/chat";
import { useModelAvailability } from "@/queries/llm";
import { AgentBar } from "./agent-bar";
import { AgentEditor } from "./agent-editor";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { SettingsDialog } from "./settings-dialog";
import { useAgents } from "./use-agents";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspace } from "./workspace-state";

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
  const { current: selected, openEditor, modelRequired } = useAgents();
  const availability = useModelAvailability(selected, modelRequired);
  const changeModel = {
    label: "更换模型",
    onClick: () => selected && openEditor(selected.id),
  };
  const blocked = !selected ? undefined : availability.state === "not_set" ? (
    <ComposerNotice
      message="这个智能体还没有选择模型。"
      actions={[{ ...changeModel, label: "选择模型" }]}
    />
  ) : availability.state === "unavailable" ? (
    <ComposerNotice
      message={availability.message}
      actions={[
        {
          label: "前往模型服务",
          onClick: () => setSettings({ open: true, section: "providers" }),
        },
        changeModel,
      ]}
    />
  ) : undefined;
  const sendMessage = useSendMessage();
  const stopReply = useStopReply();
  const answer = useAnswerInteraction();
  const onError = (error: Error) => toast.error(error.message);

  return (
    <div className="mx-auto flex h-dvh w-full min-h-0 flex-col bg-background px-4 pb-4 sm:px-6 lg:max-w-[calc(64rem+3rem)]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2">
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
            theme={workspace.sessionTheme}
            agentName={selected?.name}
            model={
              availability.state === "ok"
                ? (availability.model?.display_name ??
                  selected?.model ??
                  undefined)
                : undefined
            }
            blocked={blocked}
            messages={(chat.data?.messages ?? []).filter(
              (message) => message.agent_id === selected?.id,
            )}
            interactions={chat.data?.interactions ?? []}
            head={<AgentBar />}
            error={
              chat.error ? `无法加载对话：${chat.error.message}` : undefined
            }
            draft={draft}
            onDraftChange={setDraft}
            onSend={(text) => {
              if (!selected) {
                openEditor();
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
      <AgentEditor />
    </div>
  );
}
