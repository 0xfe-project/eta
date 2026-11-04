import type { WorkspaceView } from "./types";

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { compactionNotice } from "@/lib/compaction-notice";
import { draftText, EMPTY_DRAFT } from "@/lib/composer";
import { mentionedMembers } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { agentName } from "@/queries/agents";
import {
  useConversation,
  useConversationActions,
  useConversationList,
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
import { BottomNav, SidebarShell } from "./app-shell";
import { ChatPanel, ComposerNotice } from "./chat-panel";
import { GroupList } from "./groups";
import { NewConversationDialog } from "./new-conversation-dialog";
import { usePaneWidth } from "./pane";
import { SettingsDialog } from "./settings-dialog";
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
  // Before `hello` there is no conversation to pick, and "no conversation" reads as loaded — so
  // the list arriving is what ends the loading, not the conversation alone.
  const { loaded: listLoaded } = useConversationList();
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
  // The panel is a mode of its own on a phone, a drawer over the chat between md and lg, and a
  // column from lg up; open while mobilePanel is "workspace". Escape closes the drawer unless a
  // menu or dialog has the key.
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
  // The drawer takes the focus with it and gives it back: opening unmounts the header's button, so
  // focus would fall to the body, and closing would leave it behind the drawer. Only the drawer:
  // the phone's panel is a screen and the wide column is always there.
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(drawerOpen);
  useEffect(() => {
    if (wasOpenRef.current === drawerOpen) return;
    wasOpenRef.current = drawerOpen;
    if (!drawerMedia().matches) return;
    const panel = document.getElementById("workspace-panel");
    if (drawerOpen)
      panel
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    else if (
      document.activeElement === document.body ||
      panel?.contains(document.activeElement)
    )
      workspaceButtonRef.current?.focus();
  }, [drawerOpen]);
  return (
    <SidebarShell>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:hidden",
          groupId ? "hidden" : "flex",
        )}
      >
        {/* No gear beside the title any more: the bar's fourth cell is the way into settings on a
            phone now, and a second entry that opened a different frame was two answers to one
            question. The header itself is the phone's top rail, so it grabs the window and keeps
            clear of the lights the shell paints in that corner. */}
        {/* The phone's list is the page's content, so it is the landmark the skip link reaches;
            the bar below stays outside it, as navigation. No `id`: the chat column keeps `#main`. */}
        <main className="flex min-h-0 flex-1 flex-col focus-visible:-outline-offset-2">
          <header
            className="flex h-14 shrink-0 items-center px-5"
            data-window-drag
            data-lights-corridor
          >
            <h1 className="text-lg font-semibold">
              {translateText("sections.chat")}
            </h1>
          </header>
          <GroupList />
        </main>
        <BottomNav />
      </div>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          // Without `?group` a phone shows the list above, while a wide screen opens the
          // conversation the sidebar marks as current (the last one open, else the newest).
          groupId ? "flex" : "hidden md:flex",
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
              // The drawer's state, not "is a panel on screen": from lg up the panel is a column
              // and the header's toggle is hidden by its own breakpoints, so this only ever
              // answers the one question the button asks — is the drawer away?
              workspaceOpen={drawerOpen}
              onOpenWorkspace={showPanel}
              workspaceButtonRef={workspaceButtonRef}
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
              held={conversation.held}
              loading={!listLoaded || !conversation.loaded}
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
              onSend={(text, mode, files, blocks) => {
                if (!group) return openEditor();
                outbox.send(group.id, text, mode, targets(text), files, blocks);
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
                // A runtime's compaction leaves nothing in the transcript, so the toast tells it.
                const agentId = members.find(
                  (member) => member.sessionId === session,
                )?.agentId;
                const onRuntime = agents.some(
                  (agent) => agent.id === agentId && agent.runtime !== "eta",
                );
                const waiting = onRuntime
                  ? toast.loading(translateText("chat:compaction.running"))
                  : undefined;
                compact.mutateAsync({ session }).then(
                  ({ runtime }) => {
                    if (runtime === undefined) return;
                    const { level, text } = compactionNotice(runtime);
                    toast[level](text, { id: waiting });
                  },
                  (error: Error) => {
                    toast.dismiss(waiting);
                    onError(error);
                  },
                );
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
            style={
              { "--panel-width": `${panel.width}px` } as React.CSSProperties
            }
            className={cn(
              // Three shapes for one state. On a phone the panel is the screen: the chat column
              // has stood down, so the panel is what `main` holds. Between md and lg it is a
              // drawer over the chat; from lg up it is a column of its own, sized by the gutter
              // beside it.
              drawerOpen
                ? "max-md:flex max-md:w-full max-md:border-l-0 md:max-lg:fixed md:max-lg:inset-y-0 md:max-lg:right-0 md:max-lg:z-50 md:max-lg:flex md:max-lg:w-[min(28rem,calc(100vw-3rem))] md:max-lg:border-y-0 md:max-lg:border-r-0"
                : "md:max-lg:hidden",
              // The dragged width is a variable rather than an inline width: an inline one wins
              // over every class, which would leave the phone and the drawer at the wide
              // column's width.
              "hidden shrink-0 lg:flex lg:w-[var(--panel-width)]",
            )}
          />
        </main>
      </div>
      <SettingsDialog />
      <AgentEditor />
      <NewConversationDialog />
    </SidebarShell>
  );
}
