import type { StepItem, ToolItem, TranscriptItem } from "../contract";
import type { DrawContext, DrawnItem } from "./context";
import { Text } from "ink";
import stringWidth from "string-width";
import { truncateToWidth } from "../../../ui/text-width";
import { draw } from "./lines";
import { toolSource, toolTitle } from "./tool";

type StepsItem = Extract<TranscriptItem, { kind: "steps" }>;

const FOLDED_MARK = "▸";
const UNFOLDED_MARK = "▾";

/**
 * A reply's steps as one muted line after `▸` (`▾` unfolded): how many tools it used and how many
 * failed, the failures in the error colour; while it runs, the tool call running now or that it
 * is working. Copying it gives every step as written, a blank line between steps.
 */
export function drawSteps(item: StepsItem, context: DrawContext): DrawnItem {
  const { colors } = context;
  const mark = context.expanded ? UNFOLDED_MARK : FOLDED_MARK;
  const [words, failures] = stepsWords(item, context, stringWidth(`${mark} `));
  const node = (
    <Text wrap="truncate-end" color={colors.muted}>
      {`${mark} ${words}`}
      {failures === "" ? null : <Text color={colors.error}>{failures}</Text>}
    </Text>
  );
  return {
    lines: draw(node, context.width),
    source: item.steps.map(stepSource).join("\n\n"),
    foldable: true,
  };
}

/** The line's words, and the part saying how many failed (empty when none did). */
function stepsWords(
  item: StepsItem,
  context: DrawContext,
  markWidth: number,
): [string, string] {
  const { t } = context;
  const tools = item.steps.filter(
    (step): step is ToolItem => step.kind === "tool",
  );
  const count = tools.length;
  const last = tools.at(-1);
  if (item.replying && last?.tool.status === "running") {
    const room =
      context.width -
      markWidth -
      stringWidth(t("stepsRunning", { title: "", count }));
    const title = truncateToWidth(toolTitle(last.tool, t), Math.max(1, room));
    return [t("stepsRunning", { title, count }), ""];
  }
  if (item.replying)
    return [
      count === 1 ? t("stepsWorkingOne") : t("stepsWorking", { count }),
      "",
    ];
  const used = count === 1 ? t("stepsUsedOne") : t("stepsUsed", { count });
  const failed = tools.filter((step) => step.tool.status === "failed").length;
  if (failed === 0) return [used, ""];
  return [used + t("stepsSeparator"), t("stepsFailed", { count: failed })];
}

function stepSource(step: StepItem): string {
  return step.kind === "tool" ? toolSource(step) : step.text;
}
