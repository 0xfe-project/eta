// How full a member's context window is, and the way to empty it: the web's member ring
// (apps/web/src/components/workspace/member-ring.tsx) in words. Characters become tokens at four
// per token, over what the model is sent — the prompt, the tool definitions and the transcript from
// the last compaction on — against the model's window.

import type {
  AgentMessage,
  CompactResult,
  ViewDiagnostics,
  ViewMessageRow,
} from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { moment, reason } from "../../ui/format";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { useModels } from "../create/models";
import { tokens } from "./shared";

/** The web's window when the model list does not say. */
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

export interface ContextUse {
  used: number;
  window: number;
  percent: number;
  /** When the session last compacted; null when it never has, undefined when it is out of view. */
  compactedAt: number | null | undefined;
}

/** What a session's view says about its window. */
export function contextUse(input: {
  messages: readonly ViewMessageRow[];
  /** Rows older than the view's window: a compaction may be among them. */
  before: number;
  tools: readonly { name: string; description: string }[];
  prompt: ViewDiagnostics | undefined;
  window: number | undefined;
}): ContextUse {
  let start = 0;
  let compactedAt: number | null | undefined =
    input.before > 0 ? undefined : null;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]?.message;
    if (message?.role === "compactionSummary") {
      start = index;
      compactedAt = message.timestamp;
      break;
    }
  }
  const transcript = input.messages
    .slice(start)
    .reduce((sum, row) => sum + charsOf(row.message), 0);
  const toolDefs = input.tools.reduce(
    (sum, one) => sum + one.name.length + one.description.length,
    0,
  );
  // The prompt's two parts as the ring counts them: the stable part, and what the adaptive one adds.
  const stable = input.prompt?.stableChars ?? 0;
  const adaptive = Math.max(0, (input.prompt?.adaptiveChars ?? 0) - stable);
  const estimate = (chars: number) => Math.round(chars / 4);
  const used =
    estimate(stable) +
    estimate(adaptive) +
    estimate(toolDefs) +
    estimate(transcript);
  const window = input.window ?? FALLBACK_WINDOW;
  return {
    used,
    window,
    percent: Math.min(999, Math.round((used / Math.max(window, 1)) * 100)),
    compactedAt,
  };
}

/** The session's model's window, from the host's model list. Reactive. */
export function useWindow(): (
  modelId: string | undefined,
) => number | undefined {
  const models = useModels();
  return (modelId) =>
    modelId === undefined
      ? undefined
      : models()?.find((model) => model.id === modelId)?.contextWindow;
}

/** The member's context in the members sheet: how full, when last compacted, and Compact. */
export function ContextPanel(props: { session: string; use: ContextUse }) {
  const busy = signal(false);
  const compact = () => {
    if (busy()) return;
    busy.set(true);
    call<CompactResult>("sessions", "compact", { session: props.session })
      .then(
        ({ compacted, runtime }) => {
          if (runtime === undefined)
            toast(t(compacted ? "group.context.done" : "group.context.empty"));
          else
            toast(
              t(`group.context.${runtime.outcome}` as const, {
                runtime: runtime.runtime,
                reason: runtime.reason ?? "",
              }),
            );
        },
        (error: unknown) =>
          toast(t("common.failed", { message: reason(error) })),
      )
      .finally(() => busy.set(false));
  };
  const last = () => {
    const at = props.use.compactedAt;
    if (at === null) return t("group.context.never");
    return at === undefined ? t("group.context.unknown") : moment(at);
  };
  return (
    <View class="gap-2 border-t border-border px-4 py-3" testID="context-panel">
      <View class="h-1 flex-row bg-muted">
        <View
          class="bg-foreground"
          style={{ width: `${Math.min(100, props.use.percent)}%` }}
        />
      </View>
      <Text class="text-md leading-[18px] text-foreground">
        {t("group.context.used", {
          used: tokens(props.use.used),
          window: tokens(props.use.window),
          percent: props.use.percent,
        })}
      </Text>
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {t("group.context.lastCompaction", { time: last() })}
      </Text>
      <Button
        title={
          busy() ? t("group.context.compacting") : t("group.context.compact")
        }
        testID="context-compact"
        height={40}
        disabled={busy()}
        onPress={compact}
      />
    </View>
  );
}
