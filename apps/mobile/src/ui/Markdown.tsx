import type { TextViewClasses, TextViewCodeBlock } from "nsh/base";
import { Scroll, Text, View } from "nsh";
import { TextView } from "nsh/base";

const BODY = "text-base leading-[23px] text-foreground";

/** Black and white, as everything else: colour is left to diffs and errors. */
const parts: TextViewClasses = {
  heading: "text-foreground",
  heading1: "text-title leading-[30px]",
  heading2: "text-lead leading-[22px]",
  heading3: "text-base leading-[23px]",
  heading4: "text-base leading-[23px]",
  heading5: "text-md leading-[20px] text-muted-foreground",
  heading6: "text-md leading-[20px] text-muted-foreground",
  blockquote: "border-l-2 border-border-strong pl-3",
  alert: "bg-surface",
  alertNote: "bg-surface",
  alertTip: "bg-surface",
  alertImportant: "bg-surface",
  alertWarning: "bg-surface",
  alertCaution: "bg-surface",
  listMarker: "text-muted-foreground",
  code: "bg-muted font-mono text-foreground",
  link: "text-foreground underline",
  rule: "border-t border-border",
  table: "border border-border",
  tableCell: "text-md leading-[20px] text-foreground",
  tableHeaderCell: "text-muted-foreground",
  tableRow: "border-b border-border",
};

/** A fence's language as a diff: the one place the transcript's text may be red and green. */
const isDiff = (block: TextViewCodeBlock) =>
  block.language === "diff" || block.language === "patch";

function lineClass(block: TextViewCodeBlock, line: string): string {
  if (!isDiff(block)) return "text-foreground";
  if (line.startsWith("@@")) return "text-muted-foreground";
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "text-state-success";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "text-state-error";
  return "text-foreground";
}

/** A code block, unhighlighted: a syntax palette would spend the red and green diffs own. */
function CodeBlock(props: { block: TextViewCodeBlock }) {
  return (
    <View class="border border-border bg-surface">
      <Scroll horizontal scrollbar={false}>
        <View class="px-3 py-[10px]">
          <Each of={props.block.code.split("\n")}>
            {(line) => (
              <Text
                class={`font-mono text-sm leading-[18px] ${lineClass(props.block, line())}`}
              >
                {line() === "" ? " " : line()}
              </Text>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

/** An agent's reply, or anything else written in Markdown. Give `streaming` while it still grows. */
export function Markdown(props: {
  text: string;
  class?: string;
  streaming?: boolean;
}) {
  return (
    <TextView
      markdown={props.text}
      options={{ streaming: props.streaming === true }}
      classes={{ ...parts, root: `gap-2 ${props.class ?? BODY}` }}
      links="open"
      selectable
      renderCodeBlock={(block) => <CodeBlock block={block} />}
    />
  );
}
