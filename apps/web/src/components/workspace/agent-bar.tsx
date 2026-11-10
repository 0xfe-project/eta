import type {
  ConversationInfo,
  ConversationSummary,
  ProjectView,
} from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { SidebarIcon } from "@phosphor-icons/react/Sidebar";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { agentName, useAgentList } from "@/queries/agents";
import { AgentAvatar } from "./agent-identity";
import { ProjectChip } from "./project-chip";
import { StewardChip } from "./steward-chip";
import { useOpenAgent } from "./use-agents";

/**
 * The chat's header: what this conversation is, where it works, and who is in it.
 *
 * Three things, in that order, in one row — and nothing else. It used to be a floating band of
 * avatars *inside* the transcript: not a header, so it scrolled with the text, spent the top of
 * every conversation on decoration, and read as content rather than as navigation. A header that
 * scrolls away is not a header.
 *
 * The avatar row is navigation: pressing one opens that agent's own conversation. The name is
 * only the name: it used to open a menu that switched to an agent's direct chat, which the sidebar
 * and the avatar row already do. The folder chip says where the work happens.
 */
export function ChatHeader({
  group,
  info,
  project,
  onOpenWorkspace,
  workspaceOpen,
  workspaceButtonRef,
}: {
  group?: ConversationSummary;
  /** The conversation's own facts (its steward override); not there until its target arrives. */
  info?: ConversationInfo | undefined;
  project?: ProjectView | undefined;
  /**
   * Where the panel comes from, on the screens where it can be away: between md and lg it is a
   * drawer over the chat, and this is the only thing in the header that brings it back.
   */
  onOpenWorkspace?: () => void;
  /** The drawer's state. Not asked above lg, where the panel is a column that is always there. */
  workspaceOpen?: boolean;
  /** The toggle itself, so the drawer can hand the focus back to it when it closes. */
  workspaceButtonRef?: React.Ref<HTMLButtonElement>;
}) {
  const { t: translateText } = useTranslation(["chat", "navigation"] as const);
  const openAgent = useOpenAgent();
  const { agents } = useAgentList();
  const members = group?.participants ?? [];
  return (
    // The band clears the window's lights: a folded rail is narrower than they are, so in that
    // state their corridor continues into this column and the group's name starts past them.
    <header className="band gap-2 px-2" data-lights-shift>
      <h1 className="flex h-9 min-w-0 items-center px-1 text-sm font-medium">
        {group ? <span className="max-w-56 truncate">{group.name}</span> : null}
      </h1>
      {/* A direct conversation has one agent and one fixed folder: the chip would only
          restate the project the sidebar already has open. Groups show where they work. */}
      {group?.kind === "direct" ? null : <ProjectChip project={project} />}
      <StewardChip info={info} project={project} />
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {members.map((member) => (
          <button
            key={member.agentId}
            type="button"
            title={translateText("chat:groups.members.talkAlone", {
              name: agentName(agents, member.agentId),
            })}
            onClick={() => openAgent(member.agentId)}
            className="shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <AgentAvatar agent={{ id: member.agentId }} className="size-5" />
          </button>
        ))}
      </span>
      {/*
        The way into the panel, on the edge the panel itself comes from.

        Between md and lg the panel is a drawer, so it starts away and can be sent away — and the
        only door to it used to be inside the group's dropdown, one level below a menu that is
        about the conversation. A drawer you reopen through a menu about something else is a
        drawer people stop using: the toggle belongs in the header, where the panel is, not in the
        conversation's own menu.

        Two breakpoints leave it with nothing to do. Below md the phone's header carries it (there
        the panel is the screen, not a drawer beside it); from lg up the panel is a column that is
        always open, so a toggle would have no closed state to return from.
       */}
      {workspaceOpen === false && onOpenWorkspace !== undefined ? (
        <Button
          size="icon"
          variant="ghost"
          className="hidden md:inline-flex lg:hidden"
          aria-label={translateText("navigation:actions.openWorkspace")}
          onClick={onOpenWorkspace}
          ref={workspaceButtonRef}
        >
          {/* The left rail's own glyph, facing the other way: the right column is the left
              sidebar mirrored, and one symbol for "a panel folds here" is worth more than a
              second drawing for the same idea. */}
          <SidebarIcon aria-hidden="true" className="-scale-x-100" />
        </Button>
      ) : null}
    </header>
  );
}

/**
 * The phone's header: three things, and the row is 44 pixels tall.
 *
 * Back (to the list, or to the chat when the panel is showing), the name, and the way to what
 * this conversation is. No avatar row and no folder chip: on a phone those belong in the panel
 * and in the chat itself, and squeezing them in here would cost the name the room it needs.
 */
export function MobileChatHeader({
  name,
  onBack,
  backLabel,
  onInfo,
  infoLabel,
}: {
  name: string;
  onBack: () => void;
  backLabel: string;
  onInfo: () => void;
  infoLabel: string;
}) {
  return (
    // `data-window-drag` and the corridor: this header is the top rail on a phone — the place a
    // person grabs, and the corner the lights sit in.
    <header
      className="flex h-11 shrink-0 items-center gap-2 md:hidden"
      data-window-drag
      data-lights-corridor
    >
      <Button
        size="icon"
        variant="ghost"
        aria-label={backLabel}
        onClick={onBack}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h1>
      <Button
        size="icon"
        variant="ghost"
        aria-label={infoLabel}
        onClick={onInfo}
      >
        <InfoIcon aria-hidden="true" />
      </Button>
    </header>
  );
}
