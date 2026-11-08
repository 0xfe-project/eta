import type { TranscriptItem } from "../contract";
import type { DrawContext, DrawnItem } from "./context";
import type { RenderMessageKey } from "./messages";
import { Text } from "ink";
import { draw } from "./lines";
import { Prefixed } from "./prefixed";

type AuthorItem = Extract<TranscriptItem, { kind: "author" }>;
type OutcomeItem = Extract<TranscriptItem, { kind: "outcome" }>;
type NoticeItem = Extract<TranscriptItem, { kind: "notice" }>;

/** `● <name>` over a reply in a group conversation. */
export function drawAuthor(item: AuthorItem, context: DrawContext): DrawnItem {
  const node = (
    <Text wrap="wrap" bold color={context.colors.accent}>
      {`● ${item.name}`}
    </Text>
  );
  return {
    lines: draw(node, context.width),
    source: item.name,
    foldable: false,
  };
}

/** The reason each failure code the host knows is said with. */
const FAILURE_REASONS: Readonly<Record<string, RenderMessageKey>> = {
  restart: "failedRestart",
  run_failed: "failedRunFailed",
  unavailable: "failedUnavailable",
  gone: "failedGone",
};

/** How a reply ended when its text does not say: stopped, failed, or an error inside the run. */
export function drawOutcome(
  item: OutcomeItem,
  context: DrawContext,
): DrawnItem {
  const { colors, t } = context;
  const words = outcomeWords(item, t);
  const color = item.outcome === "stopped" ? colors.warning : colors.error;
  const node = (
    <Text wrap="wrap" color={color}>
      {words}
    </Text>
  );
  return { lines: draw(node, context.width), source: words, foldable: false };
}

function outcomeWords(item: OutcomeItem, t: DrawContext["t"]): string {
  if (item.outcome === "stopped") return t("stopped");
  if (item.outcome === "run-error")
    return `✗ ${item.text === "" ? t("runError") : item.text}`;
  const code = item.code ?? "";
  const known = Object.hasOwn(FAILURE_REASONS, code)
    ? FAILURE_REASONS[code]
    : undefined;
  const reason = t(known ?? "failedUnknown");
  // After a restart the host's words only repeat the reason.
  const detail = code === "restart" || item.text === "" ? "" : `: ${item.text}`;
  return `✗ ${reason}${detail}`;
}

/** A line about the conversation rather than in it, after `· `. */
export function drawNotice(item: NoticeItem, context: DrawContext): DrawnItem {
  const color =
    item.tone === "warning" ? context.colors.warning : context.colors.muted;
  const node = (
    <Prefixed mark="·" markColor={color}>
      <Text wrap="wrap" color={color}>
        {item.text}
      </Text>
    </Prefixed>
  );
  return {
    lines: draw(node, context.width),
    source: item.text,
    foldable: false,
  };
}
