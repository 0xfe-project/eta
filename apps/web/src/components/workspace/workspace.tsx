import type { WorkspaceView } from "./types";

import type { Draft } from "@/lib/composer";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { SidebarSimpleIcon } from "@phosphor-icons/react/SidebarSimple";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { draftText, EMPTY_DRAFT, partsText } from "@/lib/composer";
import { listSeparator } from "@/lib/i18n";
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
import { AgentBar, AgentTitle } from "./agent-bar";
import { AgentEditor } from "./agent-editor";
import { BottomNav } from "./app-shell";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { UnboundFolderNotice } from "./folder-notice";
import { GroupList } from "./groups";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { SidebarPane } from "./sidebar-pane";
import { useAgents } from "./use-agents";
import { useGroups } from "./use-groups";
import { WorkspacePanel } from "./workspace-panel";
import { useShowLinkedView } from "./workspace-search";
import { useWorkspaceStore } from "./workspace-store";

const drawerMedia = () =>
  window.matchMedia("(min-width: 768px) and (max-width: 1023.98px)");

export function Workspace({
  view,
  onViewChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}) {
  const { t: translateText } = useTranslation([
    "navigation",
    "agents",
    "chat",
    "common",
  ] as const);
  const mobilePanel = useWorkspaceStore((s) => s.mobilePanel);
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const showPanel = useWorkspaceStore((s) => s.showPanel);
  // Wide screens can fold the panel away; remembered in this browser.
  const collapsed = useWorkspaceStore(
    (s) => s.workspace.panelCollapsed ?? false,
  );
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const collapse = () => {
    setMobilePanel("chat");
    setWorkspace((workspace) => ({ ...workspace, panelCollapsed: true }));
  };
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
      message={translateText("chat:notices.groupArchived")}
      actions={[
        {
          label: translateText("chat:groups.actions.unarchive"),
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
      message={translateText("chat:notices.noMembers")}
      actions={[
        {
          label: translateText("chat:groups.actions.viewInfo"),
          onClick: () => {
            onViewChange("members");
            showPanel();
          },
        },
      ]}
    />
  ) : unavailable.length && selectedTargets.length === 1 ? (
    <ComposerNotice
      message={translateText("chat:notices.modelNotSelected", {
        agentNames: unavailable.map((a) => a!.name).join(listSeparator()),
      })}
      actions={unavailable.map((a) => ({
        label: translateText("agents:actions.configure", { name: a!.name }),
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
    onViewChange("members");
    showPanel();
  };
  // Between md and lg the panel is a drawer over the chat, open while
  // mobilePanel is "workspace"; Escape closes it unless a menu or dialog
  // has the key.
  const drawerOpen = mobilePanel === "workspace";
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        drawerMedia().matches &&
        !(event.target as Element | null)?.closest?.(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        )
      )
        setMobilePanel("chat");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [drawerOpen, setMobilePanel]);
  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <SidebarPane />
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:hidden",
          groupId ? "hidden" : "flex",
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between px-5">
          <h1 className="text-lg font-semibold">
            {translateText("sections.chat")}
          </h1>
          <SettingsButton />
        </header>
        <GroupList />
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
              mobilePanel === "workspace"
                ? translateText("actions.backToChat")
                : translateText("actions.backToConversations")
            }
            onClick={() =>
              mobilePanel === "workspace"
                ? setMobilePanel("chat")
                : void navigate({ to: "/", search: {} })
            }
          >
            <ArrowLeftIcon />
          </Button>
          <AgentTitle group={group} onInfo={showInfo} />
          <Button
            size="icon"
            variant="ghost"
            aria-label={
              direct
                ? translateText("agents:settings.title")
                : translateText("chat:groups.info")
            }
            onClick={showInfo}
          >
            <InfoIcon />
          </Button>
        </header>
        <main
          id="main"
          className={cn(
            "isolate grid min-h-0 flex-1 gap-3",
            !collapsed && "lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]",
          )}
        >
          {/* The chat alone stops at the content width; the panel beside it
              keeps its own. */}
          <div
            className={cn(
              "relative mx-auto min-h-0 w-full max-w-content min-w-0 md:px-3",
              mobilePanel === "workspace" && "hidden md:block",
            )}
          >
            <Button
              size="icon"
              variant="outline"
              aria-label={translateText("actions.openWorkspace")}
              title={translateText("sections.workspace")}
              className={cn(
                "absolute top-3 right-3 z-10 hidden bg-background shadow-sm",
                collapsed ? "md:inline-flex" : "md:max-lg:inline-flex",
              )}
              onClick={showPanel}
            >
              <SidebarSimpleIcon aria-hidden="true" className="-scale-x-100" />
            </Button>
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
              // Not a blocker: the group works without a folder, it just works somewhere nobody
              // chose. The way out sits next to the sentence.
              notice={<UnboundFolderNotice group={group} />}
              messages={history.messages}
              loading={!chat.data || history.loading}
              hasOlder={history.hasOlder}
              loadingOlder={history.loadingOlder}
              onLoadOlder={history.loadOlder}
              interactions={waiting}
              head={<AgentBar group={group} onInfo={showInfo} />}
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
                  ? translateText("chat:errors.loadConversation", {
                      message: (chat.error ?? history.error)?.message,
                    })
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
                    name:
                      file.name || translateText("chat:attachments.pastedFile"),
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
                        translateText("chat:notices.messageQueuedElsewhere", {
                          agentName: name,
                          groupName: elsewhere,
                        }),
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
                  return toast.error(
                    translateText("chat:commands.compactRequiresMention"),
                  );
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
          {drawerOpen ? (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-40 hidden bg-black/30 animate-in fade-in-0 md:max-lg:block"
              onClick={() => setMobilePanel("chat")}
            />
          ) : null}
          <WorkspacePanel
            view={view}
            onViewChange={onViewChange}
            onClose={() => setMobilePanel("chat")}
            onCollapse={collapse}
            className={cn(
              drawerOpen
                ? "md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-50 md:max-lg:w-[min(28rem,calc(100vw-3rem))] md:max-lg:border-y-0 md:max-lg:border-r-0 md:max-lg:animate-in md:max-lg:duration-200 md:max-lg:slide-in-from-right"
                : "hidden lg:flex",
              collapsed && "lg:hidden",
            )}
          />
        </main>
      </div>
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
