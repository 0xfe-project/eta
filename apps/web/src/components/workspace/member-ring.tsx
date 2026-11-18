import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { compactionNotice } from "@/lib/compaction-notice";
import { useModels } from "@/queries/providers";
import { useSession, useSessionActions } from "@/queries/sessions";
import { when } from "./routine-format";

/**
 * How full a member's context window is, as a ring around the member's own avatar.
 *
 * The avatar was already the row's first thing; putting the gauge anywhere else made the row carry
 * two avatars, which is one avatar too many. What the ring measures is the conversation the model
 * is sent — not what the member has spent over its life, which only ever grows and says nothing
 * about what is left. The denominator is the model's window, so a ring that looks half full means
 * the next turn has half the window to work with.
 *
 * It is split by where the characters came from, so a window filled by tool output looks different
 * from one filled by the person typing. Characters are turned into tokens at four per token, which
 * is the estimate the panel has always used: exact counting would cost a tokenizer per model and
 * still be wrong in the provider's favour.
 */
const FALLBACK_WINDOW = 128_000;

/** The characters a message brings into the window. Thinking and tool arguments are sent too. */
function charsOf(message: AgentMessage): number {
  const candidate = message as { content?: unknown; summary?: unknown };
  if (typeof candidate.summary === "string") return candidate.summary.length;
  if (typeof candidate.content === "string") return candidate.content.length;
  if (!Array.isArray(candidate.content)) return 0;
  let chars = 0;
  for (const block of candidate.content as {
    text?: unknown;
    thinking?: unknown;
    arguments?: unknown;
  }[]) {
    if (typeof block.text === "string") chars += block.text.length;
    if (typeof block.thinking === "string") chars += block.thinking.length;
    if (block.arguments !== undefined)
      chars += JSON.stringify(block.arguments).length;
  }
  return chars;
}

/**
 * Characters by role over the transcript the model is actually sent: from the last compaction on.
 * Before that point the conversation exists on disk but not in the window, and counting it would
 * draw a ring that is full when the model is not.
 */
function shareOf(
  messages: readonly ViewMessageRow[],
  tools: readonly { name: string; description: string }[],
): { user: number; assistant: number; tool: number; toolDefs: number } {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.message.role === "compactionSummary") {
      start = index;
      break;
    }
  }
  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const row of messages.slice(start)) {
    const chars = charsOf(row.message);
    if (row.message.role === "toolResult") tool += chars;
    else if (row.message.role === "user") user += chars;
    else assistant += chars;
  }
  const toolDefs = tools.reduce(
    (sum, one) => sum + one.name.length + one.description.length,
    0,
  );
  return { user, assistant, tool, toolDefs };
}

/**
 * How full a member's context window is: its share by source, the tokens used, the window, and
 * when the session was last compacted (undefined for never).
 */
function useContextUsage(sessionId: string) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const view = useSession(sessionId);
  const { data: models } = useModels();
  const messages = view?.transcript?.messages ?? [];
  const tools = view?.tools ?? [];
  const share = shareOf(messages, tools);
  const stableChars = view?.prompt?.stableChars ?? 0;
  const adaptiveChars = view?.prompt?.adaptiveChars ?? 0;

  const estimate = (chars: number) => Math.round(chars / 4);
  const slices = [
    {
      source: "system",
      label: translateText("chat:usage.system"),
      tokens: estimate(stableChars),
      stroke: "var(--faint)",
      opacity: 1,
    },
    {
      source: "context",
      label: translateText("chat:usage.context"),
      tokens: estimate(Math.max(0, adaptiveChars - stableChars)),
      stroke: "var(--muted-foreground)",
      opacity: 1,
    },
    {
      source: "user",
      label: translateText("chat:usage.user"),
      tokens: estimate(share.user),
      stroke: "var(--state-success)",
      opacity: 1,
    },
    {
      source: "assistant",
      label: translateText("chat:usage.assistant"),
      tokens: estimate(share.assistant),
      stroke: "var(--state-warning)",
      opacity: 1,
    },
    {
      source: "toolDefs",
      label: translateText("chat:usage.tooldefs"),
      tokens: estimate(share.toolDefs),
      // The same blue as the results it describes, dimmer: definitions and their output are one
      // story, and the eye should read the pair before it reads them apart.
      stroke: "var(--state-info)",
      opacity: 0.45,
    },
    {
      source: "tool",
      label: translateText("chat:usage.tool"),
      tokens: estimate(share.tool),
      stroke: "var(--state-info)",
      opacity: 1,
    },
  ];

  const used = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  const modelId = view?.model?.id;
  const window =
    models?.find((model) => model.id === modelId)?.contextWindow ??
    FALLBACK_WINDOW;
  // Never draw more than the ring: a window that is smaller than what is already in it (a model
  // changed under a long conversation) is full, not overflowing past its own circle.
  const cap = Math.max(window, used, 1);
  // The percentage is against the real window, so over 100% stays visible as over 100%.
  const percent = Math.min(999, Math.round((used / Math.max(window, 1)) * 100));
  const compacted = [...messages]
    .reverse()
    .find((row) => row.message.role === "compactionSummary")?.at;
  return { slices, used, window, cap, percent, compacted };
}

export function MemberRing({
  sessionId,
  children,
  size = 48,
}: {
  sessionId: string;
  children: ReactNode;
  /** The ring's box in px. The viewBox stays 48, so the geometry below scales with it. */
  size?: number;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { slices, used, window, cap, percent } = useContextUsage(sessionId);
  // The circle's circumference at r=20 in this 48-unit box: the avatar (32px) sits inside it
  // with a gap, so the ring reads as around the avatar rather than as its border.
  const circumference = 2 * Math.PI * 20;
  // The gap between slices, in this ring's units: 1.5 at the radius the panel's 124px donut uses,
  // which is a sixth of the circumference per gap here if copied verbatim. Scaled instead, so the
  // six gaps take about as much of the circle as they do there.
  const gap = 0.75;
  let offset = 0;
  const dashes = slices.map((slice) => {
    const length = (slice.tokens / cap) * circumference;
    // A slice thinner than the gap is nothing but gap; keep it out of the circle instead.
    const dash = length <= gap ? 0 : length - gap;
    const at = offset;
    offset += length;
    return { ...slice, dash, at };
  });
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={translateText("chat:usage.ring", {
        percent,
        used: used.toLocaleString(),
        window: Math.round(window / 1000).toLocaleString(),
      })}
    >
      <svg
        viewBox="0 0 48 48"
        aria-hidden="true"
        className="absolute inset-0 -rotate-90"
        style={{ width: size, height: size }}
      >
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="var(--overlay)"
          strokeWidth="3"
        />
        {dashes.map((slice) =>
          slice.dash === 0 ? null : (
            <circle
              key={slice.source}
              cx="24"
              cy="24"
              r="20"
              fill="none"
              stroke={slice.stroke}
              strokeOpacity={slice.opacity}
              strokeWidth="3"
              strokeDasharray={`${slice.dash} ${circumference - slice.dash}`}
              strokeDashoffset={-slice.at}
            >
              <title>{`${slice.label}: ~${slice.tokens.toLocaleString()} tokens`}</title>
            </circle>
          ),
        )}
      </svg>
      {children}
    </span>
  );
}

/**
 * A member's ring as a button: it opens a small panel with how full the context is, when it was
 * last compacted, and the way to compact it — this member's session in this conversation. What
 * `/compact` used to do from the composer, where the ring that measures it already is.
 */
export function MemberContext({
  sessionId,
  name,
  runtime,
  children,
}: {
  sessionId: string;
  name: string;
  /** The member's runtime: one other than eta compacts out of sight, so a toast says how it went. */
  runtime: string | undefined;
  children: ReactNode;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { used, window, percent, compacted } = useContextUsage(sessionId);
  const { compact } = useSessionActions();
  const tokens = (count: number) =>
    count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

  function run() {
    // A runtime's compaction leaves nothing in the transcript, so a toast tells how it went.
    const waiting =
      runtime !== undefined && runtime !== "eta"
        ? toast.loading(translateText("compaction.running"))
        : undefined;
    compact.mutateAsync({ session: sessionId }).then(
      ({ runtime: outcome }) => {
        if (outcome === undefined) {
          if (waiting !== undefined) toast.dismiss(waiting);
          return;
        }
        const { level, text } = compactionNotice(outcome);
        toast[level](text, { id: waiting });
      },
      (error: Error) => {
        // With no id this would dismiss every toast on the screen.
        if (waiting !== undefined) toast.dismiss(waiting);
        toast.error(error.message);
      },
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-pointer focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={translateText("compactPanel.open", { name })}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2 p-2.5">
        <p className="text-muted-foreground tabular-nums">
          {translateText("compactPanel.usage", {
            used: tokens(used),
            window: tokens(window),
            percent,
          })}
          {" · "}
          {compacted === undefined
            ? translateText("compactPanel.never")
            : translateText("compactPanel.lastCompacted", {
                time: when(compacted),
              })}
        </p>
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={compact.isPending}
            onClick={run}
          >
            {compact.isPending
              ? translateText("compaction.running")
              : translateText("compactPanel.compact")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
