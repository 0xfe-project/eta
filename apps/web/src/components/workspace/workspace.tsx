import type { WorkspaceView } from "./types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAgentMessages,
  useAnswerInteraction,
  useChat,
  useCompact,
  usePendingInteractions,
  useSendMessage,
  useStopReply,
} from "@/queries/chat";
import { useModelAvailability } from "@/queries/llm";
import { AgentBar } from "./agent-bar";
import { AgentEditor } from "./agent-editor";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { useAgents } from "./use-agents";
import { usePendingTitle } from "./use-pending-title";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspaceStore } from "./workspace-store";

export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const sessionTheme = useWorkspaceStore((s) => s.workspace.sessionTheme);
  const draft = useWorkspaceStore((s) => s.draft);
  const setDraft = useWorkspaceStore((s) => s.setDraft);
  const mobilePanel = useWorkspaceStore((s) => s.mobilePanel);
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const chat = useChat();
  const pending = usePendingInteractions().length;
  usePendingTitle();
  const { current: selected, openEditor } = useAgents();
  const history = useAgentMessages(selected?.id);
  const availability = useModelAvailability(selected);
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
  const compact = useCompact();
  const stopReply = useStopReply();
  const answer = useAnswerInteraction();
  const onError = (error: Error) => toast.error(error.message);

  return (
    // The chat fills the left; the workspace panel floats on the right,
    // inset from the window's edges.
    <div className="flex h-dvh w-full min-h-0 flex-col bg-background p-2 md:p-3">
      <h1 className="sr-only">axp.</h1>
      <div
        className="grid shrink-0 grid-cols-[1fr_1fr_auto] items-center gap-1 pb-2 md:hidden"
        aria-label="工作区面板"
      >
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
          {pending ? <span className="tabular-nums">{pending}</span> : null}
        </Button>
        <SettingsButton />
      </div>
      <main
        id="main"
        className="isolate grid min-h-0 flex-1 gap-3 md:grid-cols-2"
      >
        <div
          className={cn(
            "relative min-h-0 min-w-0 md:px-3",
            mobilePanel === "workspace" && "hidden md:block",
          )}
        >
          <SettingsButton className="absolute top-3 right-0 z-10 hidden md:inline-flex" />
          <ChatPanel
            theme={sessionTheme}
            agentId={selected?.id}
            agentName={selected?.name}
            model={
              availability.state === "ok"
                ? (availability.model?.display_name ??
                  selected?.model ??
                  undefined)
                : undefined
            }
            blocked={blocked}
            messages={history.messages}
            loading={!chat.data || history.loading}
            hasOlder={history.hasOlder}
            loadingOlder={history.loadingOlder}
            onLoadOlder={history.loadOlder}
            interactions={chat.data?.interactions ?? []}
            head={<AgentBar />}
            error={
              (chat.error ?? history.error)
                ? `无法加载对话：${(chat.error ?? history.error)?.message}`
                : undefined
            }
            draft={draft}
            onDraftChange={setDraft}
            onSend={(text, mode) => {
              if (!selected) {
                openEditor();
                return;
              }
              sendMessage.mutate(
                { agentId: selected.id, text, mode },
                { onSuccess: () => setDraft(""), onError },
              );
            }}
            onCompact={() => {
              if (!selected) {
                openEditor();
                return;
              }
              compact.mutate(selected.id, {
                onSuccess: () => setDraft(""),
                onError,
              });
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
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
