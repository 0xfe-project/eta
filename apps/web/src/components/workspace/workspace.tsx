import type { WorkspaceView } from "./types";
import type { Draft } from "@/lib/composer";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { draftText, EMPTY_DRAFT, partsText } from "@/lib/composer";
import { mentionedMembers } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import {
  chatQueryOptions,
  useAnswerInteraction,
  useCompact,
  useGroupMessages,
  usePendingInteractions,
  useStopReply,
  useStreamLost,
} from "@/queries/chat";
import { useGroupActions } from "@/queries/groups";
import {
  upload,
  useOutbox,
  useOutboxActions,
  useOutboxDelivery,
} from "@/queries/outbox";
import { AgentEditor } from "./agent-editor";
import { BottomNav, Sidebar } from "./app-shell";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { GroupBar, GroupList } from "./groups";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { useAgents } from "./use-agents";
import { useGroups } from "./use-groups";
import { WorkspacePanel } from "./workspace-panel";
import { useShowLinkedView } from "./workspace-search";
import { useWorkspaceStore } from "./workspace-store";

export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const mobilePanel = useWorkspaceStore((s) => s.mobilePanel);
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const navigate = useNavigate();
  useShowLinkedView();
  const chat = useQuery(chatQueryOptions());
  const waiting = usePendingInteractions();
  const { agents, openEditor } = useAgents();
  const { current: group, groupId, groups } = useGroups();
  const history = useGroupMessages(group?.id);
  const connectionLost = useStreamLost((s) => s.lost);
  const draftKey = group?.id ?? "";
  const draft = useOutbox((s) => s.drafts[draftKey] ?? EMPTY_DRAFT);
  const setDraft = (next: Draft) =>
    useOutbox.getState().setDraft(draftKey, next);
  const allOutgoing = useOutbox((s) => s.outgoing);
  const arrived = useMemo(
    () => new Set(history.messages.map((m) => m.id)),
    [history.messages],
  );
  useOutboxDelivery(arrived);
  const outbox = useOutboxActions();
  const outgoing = allOutgoing.filter(
    (o) => o.groupId === group?.id && !arrived.has(o.id),
  );
  const members = group?.participants.filter((p) => p.member) ?? [];
  const targets = (text: string) => {
    const ids = mentionedMembers(text, members);
    return ids.length ? ids : members.length === 1 ? [members[0].agent_id] : [];
  };
  const selectedTargets = targets(draftText(draft));
  const unavailable = selectedTargets
    .map((id) => agents.find((a) => a.id === id))
    .filter((a) => a && !a.model);
  const compact = useCompact();
  const stopReply = useStopReply();
  const answer = useAnswerInteraction();
  const actions = useGroupActions();
  const onError = (error: Error) => toast.error(error.message);
  const blocked = group?.archived ? (
    <ComposerNotice
      message="群已归档，取消归档后可以继续讨论。"
      actions={[
        {
          label: "取消归档",
          onClick: () =>
            actions.update.mutate(
              { id: group.id, archived: false },
              { onError },
            ),
        },
      ]}
    />
  ) : group && members.length === 0 ? (
    <ComposerNotice
      message="群里暂无智能体，邀请成员后可以继续讨论。"
      actions={[
        {
          label: "查看群信息",
          onClick: () => {
            onViewChange("group");
            setMobilePanel("workspace");
          },
        },
      ]}
    />
  ) : unavailable.length && selectedTargets.length === 1 ? (
    <ComposerNotice
      message={`${unavailable.map((a) => a!.name).join("、")} 还没有选择模型。`}
      actions={unavailable.map((a) => ({
        label: `设置 ${a!.name}`,
        onClick: () => openEditor(a!.id),
      }))}
    />
  ) : undefined;
  const markRead = actions.read.mutate;
  useEffect(() => {
    if (!group || group.last_seq <= group.read_seq) return;
    const read = () => {
      if (
        document.visibilityState === "visible" &&
        (groupId || window.matchMedia("(min-width: 768px)").matches)
      )
        markRead({ id: group.id, seq: group.last_seq });
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [group, groupId, markRead]);
  // A direct chat has no group info; its agent's settings stand in.
  const direct = group?.kind === "direct" ? members[0] : undefined;
  const showInfo = () => {
    if (direct) return openEditor(direct.agent_id);
    onViewChange("group");
    setMobilePanel("workspace");
  };
  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <Sidebar />
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:hidden",
          groupId ? "hidden" : "flex",
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between px-5">
          <h1 className="text-lg font-semibold">对话</h1>
          <SettingsButton />
        </header>
        <GroupList />
        <div className="px-5 py-3">
          <Button size="sm" variant="outline" onClick={() => openEditor()}>
            新建智能体
          </Button>
        </div>
        <BottomNav />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col p-2 md:flex md:p-3",
          groupId ? "flex" : "hidden",
        )}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 pb-2 md:hidden">
          <Button
            size="icon"
            variant="ghost"
            aria-label={
              mobilePanel === "workspace" ? "返回对话" : "返回对话列表"
            }
            onClick={() =>
              mobilePanel === "workspace"
                ? setMobilePanel("chat")
                : void navigate({ to: "/", search: {} })
            }
          >
            <ArrowLeftIcon />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {group?.name}
          </h1>
          <Button
            size="icon"
            variant="ghost"
            aria-label={direct ? "智能体设置" : "群信息"}
            onClick={showInfo}
          >
            <InfoIcon />
          </Button>
        </header>
        <main
          id="main"
          className="isolate grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]"
        >
          <div
            className={cn(
              "relative min-h-0 min-w-0 md:px-3",
              mobilePanel === "workspace" && "hidden md:block",
            )}
          >
            <ChatPanel
              groupId={group?.id}
              groupName={group?.name}
              group={group}
              agents={agents}
              groups={groups}
              activeReplies={chat.data?.messages ?? []}
              model={
                members.length === 1
                  ? (agents.find((a) => a.id === members[0].agent_id)?.model ??
                    undefined)
                  : members.map((p) => p.name).join(" · ")
              }
              blocked={blocked}
              messages={history.messages}
              loading={!chat.data || history.loading}
              hasOlder={history.hasOlder}
              loadingOlder={history.loadingOlder}
              onLoadOlder={history.loadOlder}
              interactions={waiting}
              head={<GroupBar group={group} onInfo={showInfo} />}
              connectionLost={connectionLost}
              outgoing={outgoing}
              onRetry={outbox.retry}
              onEdit={outbox.edit}
              onDiscard={outbox.discard}
              onResend={(parts, agentId) => {
                if (!group) return;
                const mentions = agentId
                  ? [agentId]
                  : targets(partsText(parts));
                if (partsText(parts) === "/compact" && parts.length === 1)
                  compact.mutate({ groupId: group.id, mentions }, { onError });
                else outbox.send(group.id, parts, "queue", mentions);
              }}
              error={
                (chat.error ?? history.error)
                  ? `无法加载对话：${(chat.error ?? history.error)?.message}`
                  : undefined
              }
              draft={draft}
              onDraftChange={setDraft}
              onFiles={(files) =>
                (group ? files : []).map((file) => {
                  const id = crypto.randomUUID();
                  void upload(group!.id, id, file);
                  return {
                    type: "file" as const,
                    id,
                    name: file.name || "粘贴的文件",
                    contentType: file.type || "application/octet-stream",
                    size: file.size,
                  };
                })
              }
              onSend={(parts, mode) => {
                if (!group) return openEditor();
                const mentions = targets(partsText(parts));
                if (mode === "steer") {
                  for (const id of mentions) {
                    const active = chat.data?.messages.find(
                      (m) =>
                        m.agent_id === id &&
                        [
                          "responding",
                          "waiting_for_input",
                          "stopping",
                        ].includes(m.status),
                    );
                    if (active && active.group_id !== group.id) {
                      const name = agents.find((a) => a.id === id)?.name;
                      const elsewhere = groups.find(
                        (g) => g.id === active.group_id,
                      )?.name;
                      toast.info(
                        `${name} 在「${elsewhere}」回复，这条消息已排队。`,
                      );
                    }
                  }
                }
                outbox.send(group.id, parts, mode, mentions);
                setDraft([]);
              }}
              onCompact={() => {
                if (!group) return;
                if (!selectedTargets.length)
                  return toast.error("先 @ 要压缩上下文的智能体。");
                compact.mutate(
                  { groupId: group.id, mentions: selectedTargets },
                  { onError },
                );
                setDraft([]);
              }}
              onStop={(id) => stopReply.mutate(id, { onError })}
              onStopAll={() => {
                if (group) actions.stop.mutate(group.id, { onError });
              }}
              onAnswer={(id, value) =>
                answer.mutate({ id, value }, { onError })
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
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
