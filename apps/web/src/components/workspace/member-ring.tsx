import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useModels } from "@/queries/providers";
import { useSession } from "@/queries/sessions";

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

export function MemberRing({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
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
      className="relative inline-flex size-12 shrink-0 items-center justify-center"
      title={translateText("chat:usage.ring", {
        percent,
        used: used.toLocaleString(),
        window: Math.round(window / 1000).toLocaleString(),
      })}
    >
      <svg
        viewBox="0 0 48 48"
        aria-hidden="true"
        className="absolute inset-0 size-12 -rotate-90"
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
