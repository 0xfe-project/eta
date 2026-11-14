import type {
  AgentView,
  AttachmentView,
  ConversationSummary,
  MessageView,
} from "@eta/client-contracts";
import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceState } from "./workspace-store";
import type { Draft, FilePart, PasteRange } from "@/lib/composer";
import type { ComposerTarget, StickyTarget } from "@/lib/mentions";
import type { RunBlock, ToolBlock } from "@/lib/run";
import type { Outgoing, SendMode } from "@/queries/outbox";
import type { Question } from "@/queries/questions";
import type { TaskStatus } from "@/queries/tasks";
import { MAX_ATTACHMENTS } from "@eta/client-contracts";
import { ArrowDownIcon } from "@phosphor-icons/react/ArrowDown";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Loading, Skeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  afterCommand,
  charCount,
  draftFiles,
  draftText,
  draftWithBlocks,
  isBlank,
  MAX_MESSAGE_CHARS,
  pasteBlocksOf,
  plainDraft,
} from "@/lib/composer";
import { buildMenu, hashAt, mentionAt } from "@/lib/composer-menu";
import { translate } from "@/lib/i18n";
import { mentionLabel } from "@/lib/mentions";
import { firstVisible } from "@/lib/rail";
import { runFromOf, savedSteps, savedTools, splitReply } from "@/lib/run";
import { readTheme, setTheme } from "@/lib/theme";
import {
  ACTIVE_STATUSES,
  RUNNING_STATUSES,
  taskRowsByTurn,
} from "@/lib/timeline";
import { agentName } from "@/queries/agents";
import { beginUpload, useOutbox } from "@/queries/outbox";
import { useProjectFiles } from "@/queries/projects";
import { useRunBlocks } from "@/queries/sessions";
import { useTasks } from "@/queries/tasks";
import { ActivityRefCard } from "./activity-ref";
import { AgentAvatar } from "./agent-identity";
import { CaptainReview } from "./captain-review";
import { isCaptainReviewMessage } from "./captain-review-model";
import { AttachmentChip, PasteChip } from "./composer-block";
import { ComposerEditor } from "./composer-editor";
import { EmailProposalCard } from "./email-proposal-card";
import { GroupNotice } from "./group-notice";
import { HeldMessages } from "./held-messages";
import { PendingStrip } from "./pending-strip";
import { when } from "./routine-format";
import { statusLabel } from "./task-format";
import { TaskCardRow, TaskDraftRow } from "./task-rows";
import { StatusIcon } from "./task-status-icon";
import { TranscriptRail } from "./transcript-rail";
import { AskBlock } from "./transcript/ask-block";
import { Message, SystemMessage } from "./transcript/message";
import { ProcessBox } from "./transcript/process-box";
import { SlashMenu } from "./transcript/slash-menu";
import { ThinkingBlock } from "./transcript/thinking-block";
import { ToolDetailCard } from "./transcript/tool-detail";
import { useComposerTarget } from "./use-composer-target";
import { useInputMethod } from "./use-input-method";
import { useWorkspaceStore } from "./workspace-store";

type SlashName =
  | "/stop"
  | "/queue"
  | "/steer"
  | "/compact"
  | "/goal"
  | "/theme"
  | "/settings"
  | "/new";
interface SlashCommand {
  name: SlashName | `@${string}` | `#${string}`;
  description: string;
  /** Completes to `name ` for the message to follow. */
  takesText?: boolean;
  /** The three fields below are the row's own, for the menu that shows it (slash-menu.tsx). */
  icon?: ReactNode;
  status?: string;
  ariaLabel?: string;
}
const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/stop",
    get description() {
      return translate("chat:commands.stopAllDescription");
    },
  },
  {
    name: "/queue",
    get description() {
      return translate("chat:sendModes.afterReply");
    },
    takesText: true,
  },
  {
    name: "/steer",
    get description() {
      return translate("chat:sendModes.interruptReply");
    },
    takesText: true,
  },
  {
    name: "/compact",
    get description() {
      return translate("chat:commands.compactDescription");
    },
  },
  // Commands that carry a payload. `takesText` is what makes `/goal ship it` complete to
  // `/goal ` and wait for the rest, instead of firing the moment it is picked.
  {
    name: "/goal",
    get description() {
      return translate("chat:commands.goalDescription");
    },
    takesText: true,
  },
  {
    name: "/theme",
    get description() {
      return translate("chat:commands.themeDescription");
    },
  },
  {
    name: "/settings",
    get description() {
      return translate("chat:commands.settingsDescription");
    },
  },
  {
    name: "/new",
    get description() {
      return translate("chat:commands.newDescription");
    },
  },
];

const activityText = {
  get running() {
    return translate("tasks:status.inProgress");
  },
  get completed() {
    return translate("common:actions.done");
  },
  get failed() {
    return translate("common:status.failed");
  },
};
// Failures of the host or the agent's environment, which fail everything waiting at once.
const ENVIRONMENT_FAILURES = new Set(["restart", "unavailable"]);
// How the reply codes the host fails a row with are said (chat:reply.codes.*).
const FAILURE_CODES = {
  restart: "restart",
  run_failed: "runFailed",
  unavailable: "unavailable",
  gone: "gone",
} as const;
// Settings → Appearance's chat content width, as the section's `--chat-width`: the transcript, the strip over the
// composer and `.input-outer` all read that, so they cannot come apart.
const chatWidths: Record<NonNullable<WorkspaceState["chatWidth"]>, string> = {
  "extra-narrow": "600px",
  narrow: "720px",
  standard: "860px",
  full: "none",
};

/** The files a message came with (`data.attachments`), under its text. */
function MessageFiles({ data }: { data: Record<string, unknown> }) {
  const files = Array.isArray(data.attachments)
    ? (data.attachments as Partial<AttachmentView>[]).filter(
        (file): file is AttachmentView =>
          typeof file?.id === "string" && typeof file.name === "string",
      )
    : [];
  return files.length === 0 ? null : (
    <div className="flex flex-col items-start">
      {files.map((file) => (
        <AttachmentChip key={file.id} attachment={file} />
      ))}
    </div>
  );
}

/**
 * What the user wrote. Where the message carries folded pastes (`data.blocks`, or the blocks
 * of a message still on its way out), those stretches render as the chip the composer showed,
 * and the typing around them as itself. Everything else is the text as written: a message is
 * read whole, at whatever length the author gave it.
 */
function UserText({
  text,
  blocks,
}: {
  text: string;
  blocks?: PasteRange[] | undefined;
}) {
  if (blocks !== undefined && blocks.length > 0) {
    const parts: React.ReactNode[] = [];
    let at = 0;
    for (const [start, end] of blocks) {
      if (start > at) parts.push(text.slice(at, start));
      parts.push(
        <PasteChip key={`${start}-${end}`} text={text.slice(start, end)} />,
      );
      at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return <span className="whitespace-pre-wrap">{parts}</span>;
  }
  return <span className="whitespace-pre-wrap">{text}</span>;
}

/**
 * Who a message is for, as a composer control: the button says who the next message reaches, and
 * picking replaces that for this group until it is changed. Groups only: a direct conversation
 * wakes its one member without an @, so there is no second person to pick. The steward comes first
 * as the state you return to, then Everyone, which is a real choice, not a convenience.
 */
function MemberPicker({
  members,
  steward,
  target,
  onPick,
}: {
  members: readonly { id: string; name: string }[];
  steward: { id: string; name: string } | undefined;
  target: ComposerTarget;
  onPick: (sticky: StickyTarget | undefined) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const everyone = `@${translateText("mentions.everyoneCommand")}`;
  const people =
    steward === undefined || members.some((member) => member.id === steward.id)
      ? members
      : [steward, ...members];
  const names = target.ids
    .flatMap((id) => people.filter((person) => person.id === id))
    .map((person) => mentionLabel(person, people))
    .join("、");
  const pickTargets = translateText("mentions.pickTargets");
  const notify =
    target.kind === "none"
      ? pickTargets
      : translateText("mentions.notifyTargets", { names });
  const chosen = (id: string) =>
    target.kind !== "everyone" && target.ids.includes(id);
  const check = <span aria-hidden="true">✓</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="composer-members"
          className="composer-control"
          aria-label={notify}
          title={notify}
        >
          <span className="composer-control-label max-w-40 truncate">
            {target.kind === "none"
              ? pickTargets
              : target.kind === "everyone"
                ? everyone
                : names}
          </span>
          <CaretDownIcon aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {steward === undefined ? null : (
          <DropdownMenuItem onSelect={() => onPick(undefined)}>
            <span className="min-w-0 flex-1 truncate">
              {mentionLabel(steward, people)}
            </span>
            {chosen(steward.id) ? check : null}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onPick("everyone")}>
          <span className="min-w-0 flex-1 truncate font-mono">{everyone}</span>
          {target.kind === "everyone" ? check : null}
        </DropdownMenuItem>
        {members
          .filter((member) => member.id !== steward?.id)
          .map((member) => (
            <DropdownMenuItem
              key={member.id}
              onSelect={() => onPick([member.id])}
            >
              <span className="min-w-0 flex-1 truncate">
                {mentionLabel(member, people)}
              </span>
              {chosen(member.id) ? check : null}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The host tools a script called through `eta.platform`, as the blocks a direct call would have
 * left. `esmrun` puts them in its `details.calls`; a card (an artifact, an email proposal) that
 * only knew tool blocks would otherwise vanish when the model calls the tool from code.
 */
function withRealmCalls(blocks: readonly RunBlock[]): RunBlock[] {
  return blocks.flatMap((block): RunBlock[] => {
    if (
      block.type !== "tool" ||
      (block.name !== "esmrun" && block.name !== "esmrunandkeep")
    )
      return [block];
    const calls = (block.details as { calls?: unknown } | undefined)?.calls;
    if (!Array.isArray(calls)) return [block];
    return [
      block,
      ...calls.flatMap((call, at): RunBlock[] => {
        const { tool, details, isError } = (call ?? {}) as {
          tool?: unknown;
          details?: unknown;
          isError?: unknown;
        };
        return typeof tool === "string"
          ? [
              {
                type: "tool",
                id: `${block.id}.${at}`,
                name: tool,
                input: undefined,
                details,
                status: isError === true ? "failed" : "completed",
              },
            ]
          : [];
      }),
    ];
  });
}

/** What `publish_artifact` returns in its result's `details`. */
function publishedArtifact(block: ToolBlock) {
  if (block.name !== "publish_artifact" || block.status !== "completed")
    return undefined;
  const { artifactId, title, version } = (block.details ?? {}) as {
    artifactId?: unknown;
    title?: unknown;
    version?: unknown;
  };
  return typeof artifactId === "string" &&
    typeof title === "string" &&
    typeof version === "number"
    ? { artifactId, title, version }
    : undefined;
}

/** What a reply's tool calls published, as the card values they turn into: one per publish, in the
 *  order it published them. A call that has not finished publishing (or failed) has no artifact to
 *  point at. */
function publishedRefs(blocks: readonly RunBlock[]) {
  return blocks.flatMap((block) => {
    const artifact =
      block.type === "tool" ? publishedArtifact(block) : undefined;
    return artifact === undefined
      ? []
      : [
          {
            id: block.id,
            ref: {
              kind: "artifact" as const,
              id: artifact.artifactId,
              title: artifact.title,
              // The card says which version it opens, so a reply that published the same thing
              // twice reads as that.
              number: artifact.version,
            },
          },
        ];
  });
}

function emailProposalIds(blocks: readonly RunBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type !== "tool" || block.status !== "completed") return [];
    if (block.name !== "send_email" && block.name !== "reply") return [];
    const id = (block.details as { emailProposalId?: unknown } | undefined)
      ?.emailProposalId;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * The cards a turn leaves beside its answer, in one column: the artifacts it published, in the
 * order it published them, then the task rows it wrote.
 *
 * Neither is a step the agent took, so neither is drawn in the process — a group folds that away as
 * soon as the text is written, which used to take an artifact's card out of the conversation with
 * it, leaving only the tool line that no one scrolls to. Both are things the reader is meant to
 * open, so they are drawn where the answer is, inside the turn's own frame, flush with the answer.
 * The `publish_artifact` call itself stays in the process, with the
 * arguments and result that go with it; its card is not repeated there.
 */
function TurnCards({
  saved,
  sessionId,
  runFrom,
  taskRows,
}: {
  /** The tool calls a finished reply kept on its row. */
  saved: readonly ToolBlock[];
  /** The session of a reply that is at work: its publishes come from the run, not from the row. */
  sessionId?: string | undefined;
  /** Where this reply's run starts, so a live session does not replay the previous turn. */
  runFrom?: number | undefined;
  /** The task rows this turn wrote, and which are drawn here rather than on the timeline. */
  taskRows: readonly MessageView[] | undefined;
}) {
  const live = useRunBlocks(sessionId, runFrom);
  const blocks = withRealmCalls(sessionId === undefined ? saved : live);
  const published = publishedRefs(blocks);
  const proposals = emailProposalIds(blocks);
  const rows = taskRows ?? [];
  if (published.length === 0 && proposals.length === 0 && rows.length === 0)
    return null;
  return (
    <div className="turn-tasks">
      {published.map(({ id, ref }) => (
        <ActivityRefCard key={id} value={ref} variant="framed" />
      ))}
      {proposals.map((id) => (
        <EmailProposalCard key={id} proposalId={id} />
      ))}
      {rows.map((row) => (
        <div key={row.id} id={`msg-${row.id}`} data-mid={row.id}>
          {row.kind === "task_draft" ? (
            <TaskDraftRow message={row} />
          ) : (
            <TaskCardRow message={row} />
          )}
        </div>
      ))}
    </div>
  );
}

function ToolActivity({
  block,
  sessionId,
}: {
  block: ToolBlock;
  /** The session at work, which pictures its view left out are fetched from. */
  sessionId?: string | undefined;
}) {
  return (
    <ToolDetailCard
      block={block}
      sessionId={sessionId}
      statusLabel={activityText[block.status]}
    />
  );
}

/** A warning with the ways out of it. */
export function ComposerNotice({
  message,
  actions,
}: {
  message: string;
  actions: { label: string; onClick: () => void }[];
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Warning>{message}</Warning>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

/** The blocks' warning line (`⚠ …`). */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="text-state-warning">
      <span aria-hidden>⚠ </span>
      {children}
    </div>
  );
}

/**
 * At the live end, or close enough: 32px keeps the last line readable and is far enough that a
 * stray wheel tick does not count as leaving.
 */
const GLUED_WITHIN = 32;
const glued = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < GLUED_WITHIN;

/**
 * Scrolls the transcript like a terminal: it opens at the bottom and follows
 * new output while the reader is there. Older messages added above keep the
 * view where it was, and come in as the top is approached.
 */
function useTranscriptScroll({
  groupId,
  firstId,
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  groupId: string | undefined;
  firstId: string | undefined;
  /** The conversation's own rows have not come yet: what is drawn is not where it will end. */
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Whether the view is glued to the live end. Both a ref (for the resize observer, which must not
  // re-subscribe) and state (for the button that offers to go back).
  const [pinned, setPinned] = useState(true);
  // scrollHeight - scrollTop as of the last layout, to restore after a prepend.
  const fromBottomRef = useRef(0);
  // The view as last looked at, to tell the view moving from the content moving under it.
  const seenRef = useRef({ top: 0, height: 0 });
  // A wheel or a finger is moving the view. Lasts while the view keeps rising.
  const handRef = useRef(false);
  // A jump is on its way up the transcript. Rows resolving their height can bring the bottom to it
  // on the way, and that must not re-attach it. Over once the view, away from the bottom, stops
  // rising: not `scrollend`, which the older system webviews do not have.
  const jumpingRef = useRef(false);

  function record(el: HTMLElement, following: boolean) {
    atBottomRef.current = following;
    setPinned(following);
    seenRef.current = { top: el.scrollTop, height: el.scrollHeight };
    fromBottomRef.current = el.scrollHeight - el.scrollTop;
  }
  /**
   * Only the reader leaves the bottom. Being away from it proves nothing: the scroll event comes a
   * frame late, and the content may have grown since, or rows off screen may have traded their
   * estimated height for the real one. So leaving takes the view rising, in content that held
   * still or under a hand on it; a clamp or the browser's anchoring moves it with the height.
   */
  function remember() {
    const el = scrollRef.current;
    if (!el) return;
    const seen = seenRef.current;
    const rose = el.scrollTop < seen.top;
    const left = rose && (el.scrollHeight === seen.height || handRef.current);
    handRef.current &&= rose;
    jumpingRef.current &&= rose || glued(el);
    record(
      el,
      atBottomRef.current
        ? !left || glued(el)
        : !left && !jumpingRef.current && glued(el),
    );
  }
  function follow() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    record(el, true);
  }
  function toBottom() {
    handRef.current = false;
    jumpingRef.current = false;
    follow();
  }

  // A new agent's transcript opens at its end.
  useLayoutEffect(toBottom, [groupId]);
  // Older messages arrived above: keep the same distance from the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || atBottomRef.current) return;
    el.scrollTop = el.scrollHeight - fromBottomRef.current;
    record(el, false);
  }, [firstId]);
  // Streaming output, new turns, a resized panel: follow while at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) follow();
      else record(el, glued(el) && !jumpingRef.current);
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Observed afresh after each page, so a top still in view loads the next. Not while the
  // conversation is coming in: the top of a few cached rows is not the reader reaching the top.
  useEffect(() => {
    const top = topRef.current;
    if (!top || !hasOlder || loadingOlder || loading) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadOlder();
      },
      { root: scrollRef.current, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(top);
    return () => observer.disconnect();
  }, [hasOlder, loadingOlder, loading, onLoadOlder]);

  return {
    scrollRef,
    contentRef,
    topRef,
    onScroll: remember,
    /** A wheel or a finger on the transcript: the next rise is the reader's, whatever else moved. */
    onHand: () => {
      handRef.current = true;
    },
    toBottom,
    pinned,
    /** Jump to one message by id: the rail's whole job. */
    jumpTo: (id: string) => {
      const el = scrollRef.current;
      const row = el?.querySelector<HTMLElement>(
        `[data-mid="${CSS.escape(id)}"]`,
      );
      if (!el || !row) return;
      // Stop following now: the scroll takes many frames, and new output would undo the first ones.
      const rise =
        el.getBoundingClientRect().top - row.getBoundingClientRect().top;
      if (rise >= GLUED_WITHIN) {
        jumpingRef.current = true;
        record(el, false);
      }
      row.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    /** The first message visible, so the rail can light where you are reading. */
    active: () => {
      const scroller = scrollRef.current;
      if (scroller === null) return undefined;
      const top = scroller.getBoundingClientRect().top;
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-mid]")];
      const offsets = rows.map((row) => ({
        id: row.dataset.mid ?? "",
        top: row.getBoundingClientRect().top - top,
      }));
      return firstVisible(offsets);
    },
  };
}

interface TurnActions {
  onStop: (replyId: string) => void;
  onChoose: (question: Question, selections: string[]) => void;
  onAbort: (question: Question) => void;
  onResend: (text: string, agentId?: string) => void;
}

/**
 * What a reply's outcome needs from the rest of the conversation; plain values, so a row given the
 * same ones skips rendering.
 *
 * Only outcomes: a reply that is at work is the message itself (its text lands in the row as it is
 * written), and stopping it is the composer's STOP. A second line saying "working…" under a
 * message that is visibly growing is the interface talking about itself.
 */
interface ReplyLine {
  /** The next reply failed the same way; this one says so. */
  sameAsNext?: boolean;
  /** The text of the user message a failed reply answered. */
  resend?: string;
}

/** What each reply's outcome needs from the ones around it. */
function replyLines(messages: readonly MessageView[]) {
  const replies = messages.filter(
    (m) => m.author === "agent" && m.kind === "message",
  );
  const lines = new Map<string, ReplyLine>();
  replies.forEach((message, i) => {
    if (message.status === "failed") {
      const code = String(message.data.code ?? "");
      const next = replies[i + 1];
      const trigger = messages.find(
        (m) => m.id === message.replyToId && m.author === "user",
      );
      lines.set(message.id, {
        sameAsNext:
          ENVIRONMENT_FAILURES.has(code) &&
          next?.agentId === message.agentId &&
          next?.status === "failed" &&
          next.data.code === code,
        ...(trigger === undefined ? {} : { resend: trigger.text }),
      });
    }
  });
  return lines;
}

/** The names of the agents a message went into the turns of (`steer`), for the line under it. */
const joinedNames = (message: MessageView, agents: readonly AgentView[]) =>
  Array.isArray(message.data.joined)
    ? (message.data.joined as string[])
        .map((id) => agentName(agents, id))
        .join("、")
    : "";

/**
 * A reply at work before its first block: one line the height of a thinking header, sweeping, where
 * the thinking will start. Without it the row is a name over nothing for the seconds before the
 * first token, which reads as stuck. Drawn at once (no skeleton hold): the wait is already long.
 */
function FirstToken() {
  const { t: translateText } = useTranslation("chat");
  return (
    // In the box, whose frame is the border.
    <div
      role="status"
      className="flex items-center gap-2 px-[10px] py-[5px] font-mono text-[10px] tracking-[0.08em] text-faint uppercase"
    >
      <span className="shrink-0">
        {translateText("thinking.verbs.thinking")}
      </span>
      <Skeleton className="h-2 flex-1" />
    </div>
  );
}

/**
 * One step of a reply's process: a thought, a tool call, or what the agent said between calls.
 * The same element for a reply at work and a finished one.
 */
function ProcessStepView({
  block,
  sessionId,
  streaming = false,
}: {
  block: RunBlock;
  sessionId?: string | undefined;
  streaming?: boolean;
}) {
  if (block.type === "thinking") return <ThinkingBlock text={block.text} />;
  if (block.type === "tool")
    return (
      <div data-block={block.id} className="tool-step space-y-1">
        <ToolActivity block={block} sessionId={sessionId} />
      </div>
    );
  return (
    <div className="process-note">
      <Markdown streaming={streaming}>{block.text}</Markdown>
    </div>
  );
}

/**
 * How long text written after a step goes on with no step after it before it is taken for the
 * answer. A model says a sentence before a call; the call follows within a second, and folding the
 * box under that sentence would open it again a moment later, at every step.
 */
const ANSWER_SETTLE_MS = 1500;

/** `key` has stayed the same for `ANSWER_SETTLE_MS`. */
function useSettled(key: string | undefined): boolean {
  const [settled, setSettled] = useState<string>();
  useEffect(() => {
    if (key === undefined) return;
    const timer = setTimeout(setSettled, ANSWER_SETTLE_MS, key);
    return () => clearTimeout(timer);
  }, [key]);
  return key !== undefined && settled === key;
}

/**
 * A reply that is writing now: what its session has said and done in this run. Its process goes in
 * the process box, and the text at the end (`splitReply`) is its answer: drawn under the box,
 * which folds into one row. A finished reply is drawn by the same rule from its row, so the end of
 * the run moves nothing.
 *
 * Text that follows a step stays in the box, as the step's next line, until no step has followed it
 * for `ANSWER_SETTLE_MS`: until then it is as likely a sentence before the next call. Text before
 * any step is the answer at once, so a reply without tools never draws a box.
 */
function LiveReply({
  sessionId,
  runFrom,
  waiting,
  author,
  agentId,
  time,
}: {
  sessionId: string;
  /** Where this reply's run starts in the session. */
  runFrom: number | undefined;
  /** It is waiting on the reader, not working: no first-token placeholder. */
  waiting: boolean;
  author?: string | undefined;
  agentId: string | null;
  time: string;
}) {
  const blocks = useRunBlocks(sessionId, runFrom);
  const split = splitReply(blocks);
  const settled = useSettled(
    split.steps.length === 0 ? undefined : split.answer[0]?.id,
  );
  const answered = split.steps.length === 0 || settled;
  const steps = answered ? split.steps : blocks;
  const answer = answered ? split.answer : [];
  // Nothing from the run yet: the placeholder holds the place, and the first block replaces it.
  const placeholder = blocks.length === 0 && !waiting ? <FirstToken /> : null;
  const text = answer.map((block) => (
    <div key={block.id} className="message-content">
      <Markdown streaming>{block.type === "text" ? block.text : ""}</Markdown>
    </div>
  ));
  return (
    <>
      {steps.length === 0 && placeholder === null ? null : (
        // Before the first token the box is already there, at work; its steps fill the same frame.
        <ProcessBox
          steps={
            placeholder ??
            steps.map((block) => (
              <ProcessStepView
                key={block.id}
                block={block}
                sessionId={sessionId}
                streaming
              />
            ))
          }
          count={steps.length}
          running
          folded={answer.length > 0}
          author={author}
          agentId={agentId}
          sessionId={sessionId}
          runFrom={runFrom}
          time={time}
          answer={text}
        />
      )}
      {text}
    </>
  );
}

/**
 * One message of the transcript. Memoized: a streamed update renders only
 * the message it changed, not the whole conversation.
 */
const Turn = memo(
  ({
    message,
    author,
    sessionId,
    question,
    nobody,
    joined,
    taskRowsOf,
    actions,
    ...line
  }: {
    message: MessageView;
    author?: string;
    /** The session of the member writing this reply, when it is writing. */
    sessionId?: string | undefined;
    /** What the reply is waiting on the user for. */
    question?: Question | undefined;
    /** The user message woke nobody. */
    nobody: boolean;
    /** Who the user message joined the turn of. */
    joined: string;
    /** The task rows this reply wrote, and which are drawn here rather than on the timeline. */
    taskRowsOf?: readonly MessageView[] | undefined;
    actions: React.RefObject<TurnActions>;
  } & ReplyLine) => {
    const { t: translateText } = useTranslation([
      "chat",
      "agents",
      "common",
      "captain",
      "navigation",
      "tasks",
    ] as const);
    if (isCaptainReviewMessage(message))
      return <CaptainReview message={message} />;
    if (message.kind === "system") return <GroupNotice message={message} />;
    if (message.kind === "task_draft")
      return <TaskDraftRow message={message} />;
    if (message.kind === "task_card") return <TaskCardRow message={message} />;
    if (message.author === "user")
      return (
        <>
          <Message
            role="user"
            footer={
              <time dateTime={new Date(message.createdAt).toISOString()}>
                {when(message.createdAt)}
              </time>
            }
          >
            <UserText
              text={message.text}
              blocks={pasteBlocksOf(message.data, message.text)}
            />
            <MessageFiles data={message.data} />
          </Message>
          {nobody ? (
            <p role="status" className="text-xs text-state-warning">
              {translateText("messages.nobody")}
            </p>
          ) : null}
          {joined ? (
            <p className="font-mono text-[10px] text-muted-foreground">
              {translateText("messages.joined", { names: joined })}
            </p>
          ) : null}
        </>
      );
    // Only a reply at work still grows; the rest render as finished text.
    const running = RUNNING_STATUSES.has(message.status);
    const tools = savedTools(message.data);
    // What it thought, said and did on the way, in the order the run showed it.
    const steps = savedSteps(message);
    // What it settled on: the answer whole. The one element is what both render paths show — in
    // place, and (in a group) under the whole process in the dialog.
    const answer =
      message.text === "" || message.status === "failed" ? null : (
        <div className="message-content">
          <Markdown>{message.text}</Markdown>
        </div>
      );
    // Captain's words are drawn as any agent's: its name and its face say who it is, and it has no
    // colour of its own.
    const captain = message.author === "captain";
    return (
      <div className="message assistant">
        {author === undefined ? null : (
          <div className="message-author">
            <AgentAvatar
              agent={{ id: message.agentId ?? "" }}
              className="size-[18px]"
            />
            <span>
              {captain
                ? translateText("captain:message.captain", { name: author })
                : author}
            </span>
          </div>
        )}
        {running && sessionId !== undefined ? (
          <LiveReply
            sessionId={sessionId}
            runFrom={runFromOf(message.data)}
            waiting={message.status === "waiting_for_input"}
            author={author}
            agentId={message.agentId}
            time={when(message.createdAt)}
          />
        ) : (
          <>
            {steps.length === 0 ? null : (
              <ProcessBox
                steps={steps.map((block) => (
                  <ProcessStepView key={block.id} block={block} />
                ))}
                count={steps.length}
                running={false}
                folded
                author={author}
                agentId={message.agentId}
                sessionId={sessionId}
                runFrom={runFromOf(message.data)}
                callId={tools[0]?.id}
                time={when(message.createdAt)}
                answer={answer}
              />
            )}
            {answer}
          </>
        )}
        {question === undefined ? null : (
          <AskBlock
            question={question}
            who={author}
            onChoose={(q, selections) =>
              actions.current.onChoose(q, selections)
            }
            onAbort={(q) => actions.current.onAbort(q)}
          />
        )}
        {/* The turn's own card layer: what it left for the reader to open, outside the process
            (see `TurnCards`). Inside the turn's frame, so its author and its time are the turn's. */}
        <TurnCards
          saved={tools}
          sessionId={running ? sessionId : undefined}
          runFrom={runFromOf(message.data)}
          taskRows={taskRowsOf}
        />
        <div className="message-footer">
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {when(message.createdAt)}
          </time>
          {typeof message.data.captainAssignmentId === "string" ? (
            <span data-captain-assignment={message.data.captainAssignmentId}>
              {translateText("captain:message.assignment", {
                round: String(message.data.captainRound ?? 1),
              })}
            </span>
          ) : null}
          <CopyMessage text={message.text} />
        </div>
        <ReplyOutcome
          message={message}
          line={line}
          onResend={(text) =>
            actions.current.onResend(text, message.agentId ?? undefined)
          }
        />
      </div>
    );
  },
);

/**
 * What a reply has to say about itself once it is over.
 *
 * Not while it is working: the answer is the row, growing as it is written, and the composer's
 * STOP is what stops it. A reply that is waiting its turn is also just an empty row — eta-old has
 * no "working…" line under a message, and the one this replaced was a report about the queue
 * rather than about the conversation.
 *
 * Two outcomes still need words, because neither is visible in the text: a run that was stopped
 * (the text is whatever it managed to say, which may be nothing) and a run that failed (the
 * reason, and the way back: send it again).
 */
function ReplyOutcome({
  message,
  line,
  onResend,
}: {
  message: MessageView;
  line: ReplyLine;
  onResend: (text: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
    "navigation",
    "tasks",
  ] as const);
  switch (message.status) {
    case "stopped":
      return <Warning>{translateText("common:status.stopped")}</Warning>;
    case "failed": {
      const code = String(message.data.code ?? "");
      const known = Object.hasOwn(FAILURE_CODES, code)
        ? FAILURE_CODES[code as keyof typeof FAILURE_CODES]
        : undefined;
      const reason =
        known === undefined
          ? translateText("reply.failed")
          : translateText(`reply.codes.${known}`);
      // The host's own words say why a run failed; for a restart they only repeat the reason.
      const detail =
        code === "restart" || message.text === "" ? "" : ` ${message.text}`;
      return (
        <ComposerNotice
          message={
            line.sameAsNext
              ? translateText("reply.sameFailureAsNext")
              : `${reason}${detail}`
          }
          actions={
            line.resend
              ? [
                  {
                    label: translateText("actions.resend"),
                    onClick: () => onResend(line.resend!),
                  },
                ]
              : []
          }
        />
      );
    }
    default:
      return null;
  }
}

export function ChatPanel({
  groupId,
  groupName,
  messages,
  held,
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  questions,
  draft,
  onDraftChange: setDraft,
  onSend,
  onCompact,
  onStop,
  onStopAll,
  onChoose,
  onAbort,
  head,
  error,
  connectionLost,
  blocked,
  notice,
  group,
  agents,
  outgoing,
  onRetry,
  onEdit,
  onDiscard,
  onResend,
  onGoal,
  onReload,
}: {
  groupId: string | undefined;
  groupName: string | undefined;
  /** The conversation, as far back as loaded. */
  messages: readonly MessageView[];
  /** Written, but waiting for a lane: drawn above the box, not in the transcript. */
  held: readonly MessageView[];
  /** The conversation is still being read. */
  loading?: boolean;
  /** Earlier messages exist; onLoadOlder fetches the next page of them. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Every question waiting for the user, in any conversation. */
  questions: readonly Question[];
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onSend: (
    text: string,
    mode: SendMode,
    files?: AttachmentView[],
    blocks?: PasteRange[],
  ) => void;
  onCompact: () => void;
  onStop: (replyId: string) => void;
  /** `/stop`: stops every reply in the group. */
  onStopAll: () => void;
  onChoose: (question: Question, selections: string[]) => void;
  onAbort: (question: Question) => void;
  /** Shows and switches the agent being talked to. */
  head?: React.ReactNode;
  error?: string;
  /** The live updates dropped; what shows may be out of date. */
  connectionLost?: boolean;
  /** Why the composer is disabled, with the way out. */
  blocked?: React.ReactNode;
  /** A warning above the composer that leaves it usable. */
  notice?: React.ReactNode;
  group?: ConversationSummary;
  agents: readonly AgentView[];
  /** The user's messages on their way, after the transcript. */
  outgoing: Outgoing[];
  onRetry: (outgoing: Outgoing) => void;
  onEdit: (outgoing: Outgoing) => void;
  onDiscard: (id: string) => void;
  /** Send a failed reply's message again, as a new message. */
  onResend: (text: string, agentId?: string) => void;
  /** Ask for the conversation again, when reading it failed. */
  onReload?: () => void;
  /** The goal of this conversation, moved from the composer's `/goal`. */
  onGoal: (
    action: "set" | "pause" | "resume" | "clear",
    objective?: string,
  ) => Promise<unknown>;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
    "navigation",
    "tasks",
  ] as const);
  const formRef = useRef<HTMLFormElement>(null);
  // The reply in progress; later ones wait behind it.
  const active = messages.find(
    (message) =>
      message.author === "agent" &&
      ACTIVE_STATUSES.has(message.status) &&
      message.status !== "stopping",
  );
  const lines = useMemo(() => replyLines(messages), [messages]);
  // The task rows that say which reply wrote them are drawn inside it, so the timeline proper is
  // what is left; both lists come from one pass, in the order the rows came in.
  const { rows, under } = useMemo(() => taskRowsByTurn(messages), [messages]);
  const members = useMemo(
    () =>
      (group?.participants ?? []).map((member) => ({
        ...member,
        id: member.agentId,
        name: agentName(agents, member.agentId),
      })),
    [group, agents],
  );
  const questionByAgent = useMemo(() => {
    const byAgent = new Map<string, Question>();
    for (const question of questions)
      if (question.conversationId === groupId)
        byAgent.set(question.agentId, question);
    return byAgent;
  }, [questions, groupId]);
  const sessionByAgent = useMemo(
    () =>
      new Map(
        members.flatMap((member) =>
          member.sessionId === null ? [] : [[member.id, member.sessionId]],
        ),
      ),
    [members],
  );
  // The rows call the latest handlers without taking them as props, which
  // change on every render and would undo the rows' memo.
  const actionsRef = useRef<TurnActions>({
    onStop,
    onChoose,
    onAbort,
    onResend,
  });
  useLayoutEffect(() => {
    actionsRef.current = { onStop, onChoose, onAbort, onResend };
  });
  const transcript = useTranscriptScroll({
    groupId,
    firstId: messages[0]?.id,
    loading: loading ?? false,
    hasOlder,
    loadingOlder,
    onLoadOlder,
  });

  // The rail is off until Settings → Appearance turns it on; off, nothing below is worked out for it.
  const showRail = useWorkspaceStore(
    (state) => state.workspace.transcriptRail ?? false,
  );
  const chatWidth = useWorkspaceStore(
    (state) => state.workspace.chatWidth ?? "standard",
  );
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  // What the rail numbers: the agent's replies (squares) and your own messages (circles). A
  // conversation with one of each has nothing to jump between, and the rail draws nothing. A task
  // row drawn inside a turn is not one of its own numbers, so it is not on the rail either.
  const railReplies = useMemo(
    () =>
      showRail
        ? rows
            .filter((message) => message.author === "agent")
            .map((message) => ({ id: message.id, text: message.text }))
        : [],
    [rows, showRail],
  );
  const railPrompts = useMemo(
    () =>
      showRail
        ? rows
            .filter((message) => message.author === "user")
            .map((message) => ({ id: message.id, text: message.text }))
        : [],
    [rows, showRail],
  );
  const ime = useInputMethod();
  const setSettings = useWorkspaceStore((state) => state.setSettings);
  const setNewConversation = useWorkspaceStore(
    (state) => state.setNewConversation,
  );
  const listId = useId();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const text = draftText(draft);
  const { steward, targetOf, remember } = useComposerTarget(group, agents);
  // The files in the draft, and how far each upload has got.
  const uploads = useOutbox((state) => state.uploads);
  const fileParts = draftFiles(draft);
  const uploaded = fileParts.flatMap((part) => {
    const attachment = uploads[part.id]?.attachment;
    return attachment === undefined ? [] : [attachment];
  });
  // Why the draft cannot go yet: the limits, and files that are not up.
  const hold =
    charCount(text) > MAX_MESSAGE_CHARS
      ? translateText("composer.errors.messageTooLong", {
          maxCharacters: MAX_MESSAGE_CHARS,
        })
      : fileParts.length > MAX_ATTACHMENTS
        ? translateText("composer.errors.attachmentLimit", {
            maxAttachments: MAX_ATTACHMENTS,
          })
        : fileParts.some((part) => uploads[part.id]?.error !== undefined)
          ? translateText("composer.errors.failedAttachments")
          : uploaded.length < fileParts.length
            ? translateText("composer.waitForUploads")
            : undefined;
  // The project's files, asked for from its machine once an `@` is being typed.
  const files = useProjectFiles(group?.projectId, mentionAt(text) !== null);
  // The board, for `#` — the same list the task page reads, so no second query.
  const { tasks: board } = useTasks();
  // One menu, four sources (lib/composer-menu.ts): `@` offers the group's members, then the
  // project's files, `/` offers commands, and `#` offers tasks, this group's first.
  const menu = buildMenu({
    text,
    members: members.map((member) => ({
      id: member.id,
      name: mentionLabel(member, members),
      busy: member.status !== "idle",
    })),
    files,
    commands: SLASH_COMMANDS,
    tasks: board,
    groupId,
    dismissed: menuDismissed || blocked !== undefined,
  });
  const matches: SlashCommand[] =
    menu === null
      ? []
      : menu.items.map((item): SlashCommand => {
          // A command row is the command itself, looked up by name: a copy of its fields would
          // drop `takesText`, and `/steer` picked from the menu would then fire with no words.
          // (The menu only ever lists SLASH_COMMANDS, so the fallback is for the type checker.)
          if (item.kind === "command")
            return (
              SLASH_COMMANDS.find((entry) => entry.name === item.value) ?? {
                name: item.value as SlashName,
                description: item.description,
              }
            );
          if (item.kind === "task") {
            // `#10`, the title, and the status it is in — picking a task that already finished is
            // a mistake worth showing. The status comes off the board, so it is one of the ones
            // StatusIcon draws.
            const status = statusLabel(item.status as TaskStatus);
            return {
              name: item.value.trim() as `#${string}`,
              description: item.label,
              icon: <StatusIcon status={item.status as TaskStatus} />,
              status,
              ariaLabel: translateText("composer.taskOption", {
                ref: `#${item.number}`,
                title: item.label,
                status,
              }),
            };
          }
          return {
            name: item.value.trim() as `@${string}`,
            description:
              item.kind === "file"
                ? translateText("composer.fileHint")
                : item.hint
                  ? translateText("mentions.busyHint")
                  : translateText("mentions.replyHint"),
          };
        });
  const menuOpen = matches.length > 0;
  const menuActive = Math.min(menuIndex, matches.length - 1);

  function run(name: SlashCommand["name"], rest: string) {
    if (name === "/stop") {
      onStopAll();
      setDraft([]);
    } else if (name === "/compact") {
      onCompact();
    } else if (name === "/goal") {
      // A goal set from the composer is the same goal the right panel shows: it goes through the
      // same route, so the two cannot disagree.
      if (rest.length > 0) void onGoal("set", rest);
      setDraft([]);
    } else if (name === "/theme") {
      setTheme(readTheme() === "dark" ? "light" : "dark");
      setDraft([]);
    } else if (name === "/settings") {
      setSettings((state) => ({ ...state, open: true }));
      setDraft([]);
    } else if (name === "/new") {
      setNewConversation({ open: true, projectId: group?.projectId });
      setDraft([]);
    } else if (rest.length > 0) {
      onSend(rest, name === "/steer" ? "steer" : "queue");
    }
  }
  function choose(command: SlashCommand) {
    if (command.name.startsWith("@")) {
      const next = [...draft];
      const last = next.at(-1);
      if (last?.type === "text")
        next[next.length - 1] = {
          ...last,
          text: last.text.replace(/@[^@\n]*$/, `${command.name} `),
        };
      setDraft(next);
      setMenuIndex(0);
      setMenuDismissed(true);
    } else if (command.name.startsWith("#")) {
      // A task number: replace exactly the `#…` being typed, which is the range hashAt reported,
      // and end with the space that closes the reference, as `@name ` does.
      const next = [...draft];
      const last = next.at(-1);
      const at = last?.type === "text" ? hashAt(last.text) : null;
      if (last?.type === "text" && at !== null)
        next[next.length - 1] = {
          ...last,
          text: `${last.text.slice(0, at.start)}${command.name} `,
        };
      setDraft(next);
      setMenuIndex(0);
      setMenuDismissed(true);
    } else if (command.name === "/compact" && members.length > 1)
      setDraft(plainDraft("/compact "));
    else if (command.takesText) setDraft(plainDraft(`${command.name} `));
    else run(command.name, "");
  }
  function send() {
    if (blocked !== undefined || hold !== undefined) return;
    // The button says STOP while a reply runs and the box is empty: eta-old's rule, and the
    // promise has to be kept or the button lies. Saying something with text in it still sends —
    // ⌘/Ctrl+Enter steers into the running turn instead.
    if (isBlank(draft)) {
      if (active !== undefined) onStop(active.id);
      return;
    }
    const first = text.trimStart();
    const space = first.search(/\s/);
    const name = space === -1 ? first : first.slice(0, space);
    const command = SLASH_COMMANDS.find((c) => c.name === name);
    if (command) run(command.name, afterCommand(first, name));
    else {
      // The paste blocks go with the text as the ranges they occupy in it, so the transcript
      // can fold them back into chips; a slash command's words carry none.
      const sent = draftWithBlocks(draft);
      onSend(sent.text, "queue", uploaded, sent.blocks);
    }
    // Sending jumps back to the live end, as in a terminal.
    transcript.toBottom();
    formRef.current?.querySelector<HTMLElement>("[contenteditable]")?.focus();
  }
  // Files pasted into the box or picked with the paperclip: uploading before they are sent.
  const attach = (files: File[]): FilePart[] =>
    groupId === undefined
      ? []
      : files.map((file) => beginUpload(groupId, file));
  const pick = useRef<HTMLInputElement>(null);
  const editorProps = {
    value: draft,
    onFiles: attach,
    onChange: (next: Draft) => {
      setDraft(next);
      setMenuIndex(0);
      setMenuDismissed(false);
    },
    disabled: Boolean(blocked),
    onCompositionStart: ime.onCompositionStart,
    onCompositionEnd: ime.onCompositionEnd,
    onKeyDown: (event: KeyboardEvent) => {
      // An Enter that finishes an input method's word is not a send, nor a pick (use-input-method.ts).
      if (ime.owns(event)) return;
      // ⌘/Ctrl+Enter means "send", whatever the menu is offering: steering a running turn must not
      // depend on whether a completion menu happens to be open.
      const forceSend = (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (forceSend && event.key === "Enter") {
        event.preventDefault();
        send();
        return;
      }
      if (menuOpen) {
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (step) {
          event.preventDefault();
          setMenuIndex((menuActive + step + matches.length) % matches.length);
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          choose(matches[menuActive]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      const interrupt = event.key === "Escape";
      if (interrupt && active) {
        event.preventDefault();
        onStop(active.id);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    // Nothing read yet is not "no agents": the box says nothing until it knows.
    placeholder: groupName
      ? translateText("composer.placeholder", { agentName: groupName })
      : loading
        ? ""
        : translateText("composer.createAgentFirst"),
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": menuOpen,
      "aria-controls": menuOpen ? listId : undefined,
      "aria-activedescendant": menuOpen ? `${listId}-${menuActive}` : undefined,
    } satisfies React.HTMLAttributes<HTMLDivElement>,
  };
  const slashMenu = menuOpen ? (
    <SlashMenu
      id={listId}
      rows={matches}
      active={menuActive}
      label={
        menu?.kind === "hash" ? translateText("composer.tasksLabel") : undefined
      }
      onHover={setMenuIndex}
      onChoose={(row) => choose(row as SlashCommand)}
    />
  ) : null;

  return (
    <section
      aria-label={translateText("navigation:sections.chat")}
      className="relative isolate flex h-full min-h-0 flex-col bg-background"
      style={{ "--chat-width": chatWidths[chatWidth] } as CSSProperties}
    >
      {/* eta-old's timeline: a scroller that keeps clear of the rail on its right, and the rail
          pinned to the *viewport* rather than to the content — which is the whole difference
          between a column of numbers down the side and a column of numbers in the middle of the
          text. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={transcript.scrollRef}
          onScroll={() => {
            transcript.onScroll();
            // Cheap enough: one pass over the rows that are actually in the DOM.
            if (showRail) setActiveId(transcript.active());
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) transcript.onHand();
          }}
          onTouchMove={transcript.onHand}
          className="no-scrollbar h-full overflow-y-auto py-4 pr-14 pl-6"
        >
          {/* Floats over the transcript, which scrolls on beneath it and stays
            clickable around it; only the buttons catch. */}
          {head ? (
            <div className="pointer-events-none sticky top-0 z-10 [&_button]:pointer-events-auto">
              {head}
            </div>
          ) : null}
          {/* The rail is inside the scroll container so it can stick to the top of what you see;
            it takes a lane on the right and the transcript keeps clear of it. */}
          {/* Everything a run is standing still on, in one line each, wherever you are in the
            transcript. The cards inside the turns stay: they are the same questions in their own
            place. */}
          <PendingStrip
            questions={questions}
            agents={agents}
            onChoose={onChoose}
          />
          <div className="mx-auto max-w-(--chat-width)">
            <div className="min-w-0">
              <div
                ref={transcript.contentRef}
                className="font-sans text-sm leading-[1.65] text-foreground"
              >
                {/* No welcome banner: eta-old's transcript starts with the first message. The only
                  thing above it is the way back to earlier pages, and it appears when they exist. */}
                {hasOlder ? (
                  <div ref={transcript.topRef}>
                    <SystemMessage>
                      {translateText("history.loadEarlier")}
                    </SystemMessage>
                  </div>
                ) : null}
                {/*
                 * The four states a conversation can be in, in one place and in the same words as
                 * the rest of the app: it failed (and can be asked again), the live updates dropped
                 * (and it reconnects itself), it is still being read, or there is nothing here yet.
                 * They live above the transcript rather than inside it so they do not scroll away
                 * with the thing they describe.
                 */}
                {error !== undefined ? (
                  <div className="border border-state-error px-2 py-1 text-xs">
                    <div role="alert" className="text-state-error">
                      {error}
                    </div>
                    {onReload === undefined ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        className="mt-1"
                        onClick={onReload}
                      >
                        {translateText("common:actions.retry")}
                      </Button>
                    )}
                  </div>
                ) : null}
                {connectionLost && error === undefined ? (
                  <p
                    role="status"
                    className="border border-state-warning px-2 py-1 text-xs text-state-warning"
                  >
                    {translateText("connection.reconnecting")}
                  </p>
                ) : null}
                {loading && error === undefined && !messages.length ? (
                  // The turns' outline, where the turns will land. The words stay as its name.
                  <Loading
                    layout="messages"
                    rows={4}
                    label={translateText("history.loading")}
                  />
                ) : null}
                {!loading && !error && messages.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    {translateText(
                      groupId === undefined
                        ? "groups.empty.title"
                        : "history.empty",
                    )}
                  </p>
                ) : null}
                {/* Off-screen turns skip rendering; `auto` remembers their size. */}
                <div
                  className="space-y-3 pt-1 *:[contain-intrinsic-size:auto_120px] *:[content-visibility:auto]"
                  role="log"
                  aria-label={translateText("accessibility.messages")}
                  aria-live="polite"
                >
                  {rows.map((message) => (
                    <div
                      key={message.id}
                      id={`msg-${message.id}`}
                      data-mid={message.id}
                    >
                      <Turn
                        key={message.id}
                        message={message}
                        taskRowsOf={under.get(message.id)}
                        author={
                          message.author === "captain"
                            ? agentName(agents, message.agentId)
                            : message.author === "agent" &&
                                (group?.kind === "group" ||
                                  (group?.participants.length ?? 0) > 1 ||
                                  message.kind === "mention")
                              ? agentName(agents, message.agentId)
                              : undefined
                        }
                        sessionId={
                          message.agentId === null
                            ? undefined
                            : sessionByAgent.get(message.agentId)
                        }
                        question={
                          message.status === "waiting_for_input" &&
                          message.agentId !== null
                            ? questionByAgent.get(message.agentId)
                            : undefined
                        }
                        nobody={
                          message.author === "user" &&
                          Array.isArray(message.data.woke) &&
                          message.data.woke.length === 0 &&
                          Array.isArray(message.data.joined) &&
                          message.data.joined.length === 0
                        }
                        joined={
                          message.author === "user"
                            ? joinedNames(message, agents)
                            : ""
                        }
                        {...lines.get(message.id)}
                        actions={actionsRef}
                      />
                    </div>
                  ))}
                  {outgoing.map((item) => (
                    <div key={item.id} className="space-y-3 pt-1">
                      <Message role="user">
                        <UserText text={item.text} blocks={item.blocks} />
                        {item.attachments.map((file) => (
                          <div key={file.id}>
                            <AttachmentChip attachment={file} />
                          </div>
                        ))}
                      </Message>
                      {item.failure ? (
                        <ComposerNotice
                          message={item.failure}
                          actions={[
                            {
                              label: translateText("common:actions.retry"),
                              onClick: () => onRetry(item),
                            },
                            {
                              label: translateText("common:actions.edit"),
                              onClick: () => onEdit(item),
                            },
                            {
                              label: translateText("common:actions.discard"),
                              onClick: () => onDiscard(item.id),
                            },
                          ]}
                        />
                      ) : (
                        <div role="status" className="text-muted-foreground">
                          {translateText("common:states.sending")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* Off the live end: say there is more, and who is adding it. Following resumes the
            moment you scroll back down, or here. */}
          {transcript.pinned ? null : (
            // The same floating control as back-to-top: an outline button lifted off the text.
            <Button
              variant="outline"
              size="sm"
              onClick={() => transcript.toBottom()}
              className="sticky bottom-2 z-10 mx-auto flex w-fit shadow-sm dark:bg-background"
            >
              <ArrowDownIcon aria-hidden="true" data-icon="inline-start" />
              {translateText("chat:rail.newActivity")}
              {members.some((member) => member.status !== "idle")
                ? ` · ${members
                    .filter((member) => member.status !== "idle")
                    .map((member) => member.name)
                    .join("、")}`
                : ""}
            </Button>
          )}
        </div>
        {showRail && (
          <div className="absolute top-16 right-1">
            <TranscriptRail
              replies={railReplies}
              prompts={railPrompts}
              activeId={activeId}
              onJump={transcript.jumpTo}
            />
          </div>
        )}
      </div>
      {/*
       * The composer, copied from eta-old rather than improvised: `.input-area` → `.input-outer`
       * → `.composer-card` (which is the bordered box, and turns its border on when something
       * inside has focus) → the editor → `.composer-toolbar` with the controls on the left, the
       * hint in the middle and send on the right. The class names are its class names, and the
       * CSS behind them was ported with them, because the previous version was invented here and
       * came out worse than the thing it replaced.
       */}
      <footer className="input-area">
        {/* Its own strip above the frame, not a row inside it: the frame is one thing — a notice,
            the box, the toolbar — and a message that has not been sent yet is not part of it. */}
        <div className="mx-auto w-full max-w-(--chat-width) px-1 pb-1.5">
          {/* What is waiting behind the run in flight, over the box that would send it. */}
          <HeldMessages
            conversationId={groupId ?? ""}
            held={held}
            // Back above the draft, blank line between: pulling one in must never swallow the
            // half sentence someone was writing, and two pulls land newest-first.
            onPullBack={(text) =>
              setDraft(
                draft.length === 0
                  ? [{ type: "text", text }]
                  : [
                      { type: "text", text },
                      { type: "text", text: "\n\n" },
                      ...draft,
                    ],
              )
            }
          />
        </div>
        <div className="input-outer">
          {/*
           * In priority order, and each one is a different sentence: why the box cannot be used
           * (blocked), why this draft cannot go (hold — too long), a warning that leaves it usable
           * (notice). Only the first that applies is shown.
           */}
          {blocked !== undefined ? (
            <div className="border-b px-3 py-1.5 text-xs">{blocked}</div>
          ) : hold !== undefined ? (
            <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              {hold}
            </div>
          ) : (
            // Rendered as given, not wrapped: a notice is a component that draws its own box
            // (a dashed frame, an icon, the way out). Wrapping it in a bordered div meant the
            // wrapper stayed — an empty strip above the input — whenever the notice itself had
            // nothing to say, which is most of the time.
            notice
          )}
          <form
            ref={formRef}
            className="composer-card"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <fieldset disabled={Boolean(blocked)} className="contents">
              {slashMenu}
              {/* eta-old's editor: the box is the border, the textarea is nothing but the text
                  area. No `❯`, no mode line, no second and third frame around it. */}
              <ComposerEditor
                key={groupId}
                className="composer-editor"
                {...editorProps}
              />
              <div className="composer-toolbar">
                <div className="composer-controls flex min-w-0 items-center gap-2">
                  {group?.kind === "direct" ? null : (
                    <MemberPicker
                      members={members}
                      steward={steward}
                      target={targetOf(text)}
                      onPick={remember}
                    />
                  )}
                  <button
                    type="button"
                    className="composer-control"
                    aria-label={translateText("attachments.pick")}
                    title={translateText("attachments.pick")}
                    disabled={groupId === undefined}
                    onClick={() => pick.current?.click()}
                  >
                    <PaperclipIcon aria-hidden="true" className="size-3.5" />
                  </button>
                  <input
                    ref={pick}
                    type="file"
                    multiple
                    hidden
                    data-testid="composer-pick"
                    onChange={(event) => {
                      const picked = [...(event.target.files ?? [])];
                      event.target.value = "";
                      if (picked.length)
                        setDraft([...draft, ...attach(picked)]);
                    }}
                  />
                  <span className="composer-toolbar-hints min-w-0 truncate">
                    {active === undefined
                      ? translateText("composer.sendHint")
                      : translateText("composer.workingHint")}
                  </span>
                </div>
                <Button
                  type="submit"
                  className="composer-control composer-submit-control"
                  disabled={blocked !== undefined || hold !== undefined}
                >
                  {isBlank(draft) && active !== undefined
                    ? translateText("composer.stopLabel")
                    : translateText("common:actions.send")}
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      </footer>
    </section>
  );
}

/**
 * Copy what the agent said, from under the message.
 *
 * The whole point of the footer is that it is out of the way until you want it: the button is
 * 10px mono in the same dim line as the time, and it says "copied" for a beat rather than
 * throwing a toast for a click you already know you made.
 */
function CopyMessage({ text }: { text: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [copied, setCopied] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <button
      type="button"
      className="message-copy-btn font-mono text-[10px] uppercase tracking-[0.1em]"
      data-copied={copied}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(setCopied, 1200, false);
        } catch {
          /* no clipboard outside a secure context */
        }
      }}
    >
      {copied
        ? translateText("common:feedback.copied")
        : translateText("common:actions.copy")}
    </button>
  );
}
