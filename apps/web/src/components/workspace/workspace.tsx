import type { WorkspaceView } from "./types";

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { draftText, EMPTY_DRAFT } from "@/lib/composer";
import { mentionedMembers } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";
import {
  useConversation,
  useConversationActions,
} from "@/queries/conversations";
import {
  useOutbox,
  useOutboxActions,
  useOutboxDelivery,
} from "@/queries/outbox";
import { useProjects } from "@/queries/projects";
import { useAnswerQuestion, useQuestions } from "@/queries/questions";
import { useSessionActions } from "@/queries/sessions";
import { useConnectionLost } from "@/queries/wire";
import { ChatHeader, MobileChatHeader } from "./agent-bar";
import { AgentEditor } from "./agent-editor";
import { BottomNav } from "./app-shell";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { GroupList } from "./groups";
import { usePaneWidth } from "./pane";
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
  // No folding on wide screens: eta-old's right column is always there from `lg` up, and a panel
  // you have to remember to open is a panel that stays closed. Below `lg` it is a drawer, which is
  // where a fold is the only way to fit.
  // The right column's width, kept per screen like the left one's: 320 is where the member blocks'
  // numbers stop colliding, 720 is where the chat would stop being the thing you read.
  const panel = usePaneWidth({
    storageKey: "eta.panel.width",
    min: 320,
    max: 720,
    fallback: 400,
    edge: "right",
  });
  const navigate = useNavigate();
  useShowLinkedView();
  const questions = useQuestions();
  const { agents, openEditor } = useAgents();
  const { current: group, groupId } = useGroups();
  const conversation = useConversation(group?.id);
  const { projects } = useProjects();
  const project = projects.find(
    (candidate) => candidate.id === group?.projectId,
  );
  const connectionLost = useConnectionLost();
  const draftKey = group?.id ?? "";
  const draft = useOutbox((s) => s.drafts[draftKey] ?? EMPTY_DRAFT);
  const setDraft = (next: typeof draft) =>
    useOutbox.getState().setDraft(draftKey, next);
  const allOutgoing = useOutbox((s) => s.outgoing);
  const arrived = useMemo(
    () => new Set<string>(conversation.messages.map((m) => m.id)),
    [conversation.messages],
  );
  useOutboxDelivery(arrived);
  const outbox = useOutboxActions();
  const outgoing = allOutgoing.filter(
    (o) => o.conversationId === group?.id && !arrived.has(o.id),
  );
  const members = group?.participants ?? [];
  // Who the text names. Naming nobody is a message for the steward, which the host decides.
  const targets = (text: string) =>
    mentionedMembers(
      text,
      members.map((member) => ({
        id: member.agentId,
        name: agentName(agents, member.agentId),
      })),
    );
  const { stop, read } = useConversationActions();
  const { compact, goal: setGoal } = useSessionActions();
  const { choose, abort } = useAnswerQuestion();
  // Narrowing the chat to one member: the state lives in the store, because the sidebar's member
  // rows and the panel's member cards are the same action. It resets when the conversation does.
  const focusAgent = useWorkspaceStore((s) => s.focusedAgentId);
  const setFocusedAgent = useWorkspaceStore((s) => s.setFocusedAgent);
  useEffect(() => setFocusedAgent(null), [group?.id, setFocusedAgent]);
  // Which session a goal set from the composer lands on: the member being talked to, or the first
  // one that has a conversation. A group has one goal per member; the composer speaks for the one
  // you are addressing.
  const sessionOf = (agentId: string | undefined) =>
    members.find((member) => member.agentId === agentId)?.sessionId ??
    undefined;
  const goalSessionId =
    (targets(draftText(draft)).map(sessionOf).find(Boolean) ??
      members.find((member) => member.sessionId !== null)?.sessionId) ||
    undefined;
  const onError = (error: Error) => toast.error(error.message);
  const { update } = useConversationActions();
  const blocked = group?.archived ? (
    <ComposerNotice
      message={translateText("chat:notices.groupArchived")}
      actions={[
        {
          label: translateText("chat:groups.actions.unarchive"),
          onClick: () =>
            update.mutate(
              { conversationId: group.id, archived: false },
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
            onViewChange("context");
            showPanel();
          },
        },
      ]}
    />
  ) : undefined;
  const markRead = read.mutate;
  useEffect(() => {
    if (!group || group.lastSeq <= group.readSeq) return;
    const mark = () => {
      if (
        document.visibilityState === "visible" &&
        (groupId || window.matchMedia("(min-width: 768px)").matches)
      )
        markRead({ conversationId: group.id, seq: group.lastSeq });
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [group, groupId, markRead]);
  // A direct chat has no group info; its agent's settings stand in.
  const direct = group?.kind === "direct" ? members[0] : undefined;
  const showInfo = () => {
    if (direct) return openEditor(direct.agentId);
    onViewChange("context");
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
          "min-h-0 min-w-0 flex-1 flex-col",
          groupId ? "flex" : "hidden",
        )}
      >
        <MobileChatHeader
          name={group?.name ?? translateText("sections.chat")}
          onBack={() =>
            mobilePanel === "workspace"
              ? setMobilePanel("chat")
              : void navigate({ to: "/", search: {} })
          }
          backLabel={
            mobilePanel === "workspace"
              ? translateText("actions.backToChat")
              : translateText("actions.backToConversations")
          }
          onInfo={showInfo}
          infoLabel={
            direct
              ? translateText("agents:settings.title")
              : translateText("chat:groups.info")
          }
        />
        <main id="main" className="isolate flex min-h-0 flex-1">
          {/* The chat alone stops at the content width; the panel beside it
              keeps its own. */}
          <div
            className={cn(
              // Flush with the gutters: no padding, no card, no gap. The column *is* the band
              // down the middle — one object from the header rule to the bottom of the window.
              "relative flex min-h-0 w-full min-w-0 flex-col",
              mobilePanel === "workspace" && "hidden md:flex",
            )}
          >
            <ChatHeader
              group={group}
              info={conversation.info}
              project={project}
              onInfo={showInfo}
              workspaceOpen
              onOpenWorkspace={showPanel}
            />
            <ChatPanel
              groupId={group?.id}
              groupName={group?.name}
              group={group}
              agents={agents}
              blocked={blocked}
              messages={
                focusAgent === null
                  ? conversation.messages
                  : conversation.messages.filter(
                      (message) =>
                        message.author !== "agent" ||
                        message.agentId === focusAgent,
                    )
              }
              loading={!conversation.loaded}
              hasOlder={conversation.hasOlder}
              loadingOlder={conversation.loadingOlder}
              onLoadOlder={conversation.loadOlder}
              questions={questions}
              connectionLost={connectionLost}
              outgoing={outgoing}
              onRetry={outbox.retry}
              onEdit={outbox.edit}
              onDiscard={outbox.discard}
              onResend={(text, agentId) => {
                if (!group) return;
                outbox.send(
                  group.id,
                  text,
                  "queue",
                  agentId ? [agentId] : targets(text),
                );
              }}
              onReload={conversation.loadOlder}
              onGoal={(action, objective) =>
                // Through the session, like the panel's own buttons: one writer for a goal means
                // the two can never show different ones.
                goalSessionId === undefined
                  ? Promise.resolve()
                  : setGoal.mutateAsync({
                      session: goalSessionId,
                      action,
                      ...(objective === undefined ? {} : { objective }),
                    })
              }
              error={
                conversation.error
                  ? translateText("chat:errors.loadConversation", {
                      message: conversation.error.message,
                    })
                  : undefined
              }
              draft={draft}
              onDraftChange={setDraft}
              onSend={(text, mode) => {
                if (!group) return openEditor();
                outbox.send(group.id, text, mode, targets(text));
                setDraft([]);
              }}
              onCompact={() => {
                const text = draftText(draft);
                const named = targets(text).map(sessionOf);
                const sessions = named.length
                  ? named
                  : members.length === 1
                    ? [members[0]?.sessionId]
                    : [];
                const session = sessions.find(
                  (id): id is string => typeof id === "string",
                );
                if (session === undefined)
                  return void toast.error(
                    translateText("chat:commands.compactRequiresMention"),
                  );
                compact.mutate({ session }, { onError });
                setDraft([]);
              }}
              onStop={(messageId) => {
                if (group)
                  stop.mutate(
                    { conversationId: group.id, messageId },
                    { onError },
                  );
              }}
              onStopAll={() => {
                if (group)
                  stop.mutate({ conversationId: group.id }, { onError });
              }}
              onChoose={(question, selections) =>
                choose(question, selections, { onError })
              }
              onAbort={(question) => abort(question, { onError })}
            />
          </div>
          {drawerOpen ? (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-40 hidden bg-black/30 md:max-lg:block"
              onClick={() => setMobilePanel("chat")}
            />
          ) : null}
          {/* The second gutter: drag it and the chat gives up width to the panel. Same line,
              same band across the top — that is what makes the header read as one object. */}
          <div
            aria-label={translateText("accessibility.resizePanel")}
            className="pane-divider hidden lg:block"
            {...panel.dividerProps}
          />
          <WorkspacePanel
            view={view}
            onViewChange={onViewChange}
            onClose={() => setMobilePanel("chat")}
            style={{ width: panel.width }}
            className={cn(
              // Between md and lg the panel is a drawer over the chat; from lg up it is a column
              // of its own, sized by the gutter beside it.
              drawerOpen
                ? "md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-50 md:max-lg:flex md:max-lg:w-[min(28rem,calc(100vw-3rem))] md:max-lg:border-y-0 md:max-lg:border-r-0"
                : "md:max-lg:hidden",
              "hidden shrink-0 lg:flex",
            )}
          />
        </main>
      </div>
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
