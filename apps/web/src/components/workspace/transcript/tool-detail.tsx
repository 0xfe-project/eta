import type { ReactNode } from "react";
import type { ToolBlock } from "@/lib/run";
import type {
  ChildStep,
  FilePatch,
  PlanItem,
  ToolShape,
} from "@/lib/tool-shape";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  exitCodeOf,
  fullOutputOf,
  patchCounts,
  runtimeTaskOf,
  shapeOf,
  withoutAnsi,
} from "@/lib/tool-shape";
import { summarizeArgs } from "@/lib/tool-summary";
import { cn } from "@/lib/utils";
import { ImageStrip } from "./image-strip";
import { ToolCard, ToolCardBlock } from "./tool-card";

/**
 * One tool call as a card whose body is drawn for what the call was: an edit as the lines it
 * changed, a command as a terminal, a to-do list as its steps, a screenshot as the picture. A call
 * the page has no shape for shows its arguments and output, as every card used to.
 */
export function ToolDetailCard({
  block,
  sessionId,
  progress,
  statusLabel,
}: {
  block: ToolBlock;
  /** The session the call ran in, which pictures the view left out are fetched from. */
  sessionId?: string | null | undefined;
  /** What a running call has printed so far. */
  progress?: string | undefined;
  statusLabel: string;
}) {
  const shape = shapeOf(block);
  return (
    <ToolCard
      tool={block.name}
      summary={summaryOf(block, shape) || undefined}
      meta={<ToolMeta block={block} shape={shape} />}
      status={block.status}
      statusLabel={statusLabel}
    >
      <ToolBody
        block={block}
        shape={shape}
        sessionId={sessionId}
        progress={progress}
      />
    </ToolCard>
  );
}

function summaryOf(block: ToolBlock, shape: ToolShape): string {
  if (shape.kind === "command") return summarizeArgs(shape.command);
  if (shape.kind === "patch" && shape.files.length > 1)
    return `${shape.files[0]!.path} +${shape.files.length - 1}`;
  if (shape.kind === "patch" && shape.files[0]!.path !== "")
    return summarizeArgs(shape.files[0]!.path);
  return summarizeArgs(block.input);
}

/** The one fact worth seeing before opening a card. */
function ToolMeta({ block, shape }: { block: ToolBlock; shape: ToolShape }) {
  const { t: translateText } = useTranslation("chat");
  if (shape.kind === "patch") {
    const { added, removed } = patchCounts(shape.files);
    if (added + removed === 0) return null;
    return (
      <>
        <span className="diff-count add">+{added}</span>{" "}
        <span className="diff-count del">−{removed}</span>
      </>
    );
  }
  const code = exitCodeOf(block);
  if (code !== undefined && code !== 0)
    return (
      <span className="diff-count del">
        {translateText("tools.exit", { code: code ?? "?" })}
      </span>
    );
  const images = block.images?.length ?? 0;
  if (images > 0)
    return <>{translateText("tools.images", { count: images })}</>;
  const steps = childrenOf(block).filter((step) => step.kind === "tool").length;
  if (steps > 0) return <>{translateText("tools.steps", { count: steps })}</>;
  return null;
}

function ToolBody({
  block,
  shape,
  sessionId,
  progress,
}: {
  block: ToolBlock;
  shape: ToolShape;
  sessionId: string | null | undefined;
  progress: string | undefined;
}) {
  const { t: translateText } = useTranslation("chat");
  const output =
    block.output ?? (block.status === "running" ? progress : undefined);
  const children = childrenOf(block);
  const task = runtimeTaskOf(block);
  const fullOutput = fullOutputOf(block);
  // A result that only says the edit or write went through repeats the header.
  const quietOutput =
    (shape.kind === "patch" ||
      shape.kind === "write" ||
      shape.kind === "plan") &&
    block.status === "completed";
  return (
    <>
      {shape.kind === "command" ? (
        <ToolCardBlock label={translateText("tools.command")}>
          <span className="terminal-prompt">$ </span>
          {shape.command}
        </ToolCardBlock>
      ) : shape.kind === "patch" ? (
        shape.files.map((file, index) => (
          <ToolCardBlock
            // One call names a file once; the index only breaks ties a patch never has.
            // eslint-disable-next-line react/no-array-index-key
            key={`${file.path}:${index}`}
            label={fileLabel(file, translateText)}
            verbatim
            className="tool-card-plain"
          >
            <PatchView patch={file.patch} />
          </ToolCardBlock>
        ))
      ) : shape.kind === "write" ? (
        <ToolCardBlock
          label={`${shape.path} · +${lineCount(shape.content)}`}
          verbatim
          className="tool-card-plain"
        >
          <Folded text={shape.content} />
        </ToolCardBlock>
      ) : shape.kind === "plan" ? (
        <ToolCardBlock
          label={translateText("tools.plan")}
          className="tool-card-plain"
        >
          <PlanList items={shape.items} />
        </ToolCardBlock>
      ) : block.input === undefined || block.input === null ? null : (
        <ToolCardBlock
          label={translateText("tools.arguments")}
          className="tool-card-plain"
        >
          <Folded
            text={
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input, null, 2)
            }
          />
        </ToolCardBlock>
      )}
      {task === undefined ? null : (
        <ToolCardBlock label={translateText("tools.runtimeTask")}>
          {[
            task.background === true ? translateText("tools.background") : null,
            task.description,
            task.status,
            task.summary,
          ]
            .filter(
              (part) => part !== undefined && part !== null && part !== "",
            )
            .join(" · ")}
        </ToolCardBlock>
      )}
      {children.length === 0 ? null : (
        <ToolCardBlock
          label={translateText("tools.children")}
          className="tool-card-plain"
        >
          <ChildSteps steps={children} />
        </ToolCardBlock>
      )}
      {output === undefined || output === "" || quietOutput ? null : (
        <ToolCardBlock
          label={
            block.status === "running"
              ? translateText("tools.printing")
              : translateText("tools.result")
          }
          className="tool-card-plain"
        >
          <Folded text={withoutAnsi(output)} />
          {fullOutput === undefined ? null : (
            <p className="tool-card-note">
              {fullOutput === ""
                ? translateText("tools.truncated")
                : translateText("tools.truncatedAt", { path: fullOutput })}
            </p>
          )}
        </ToolCardBlock>
      )}
      {block.images === undefined || block.images.length === 0 ? null : (
        <div className="tool-card-block">
          <ImageStrip sessionId={sessionId} images={block.images} />
        </div>
      )}
    </>
  );
}

function fileLabel(
  file: FilePatch,
  translateText: (key: "tools.added" | "tools.deleted") => string,
): string {
  if (file.change === "add")
    return `${file.path} · ${translateText("tools.added")}`;
  if (file.change === "delete")
    return `${file.path} · ${translateText("tools.deleted")}`;
  return file.path;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Past this many lines a block is folded to its first ones, with the rest one click away. */
const FOLD_LINES = 14;
/** Or past this many characters: one long line folds too. */
const FOLD_CHARS = 1600;

/**
 * Text that may be long: past fourteen lines it shows the first ones and says how many more there
 * are. Opened, it is all there and folds back again.
 */
function Folded({
  text,
  children,
}: {
  text: string;
  /** Drawn instead of the text, when the text is only how long it is (a diff draws its own lines). */
  children?: ReactNode;
}) {
  const { t: translateText } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  const long = lines > FOLD_LINES || text.length > FOLD_CHARS;
  return (
    <div className="folded" data-open={!long || open ? "true" : undefined}>
      <div className="folded-body">{children ?? text}</div>
      {long ? (
        <button
          type="button"
          className="folded-toggle"
          onClick={() => setOpen((was) => !was)}
        >
          {open
            ? translateText("tools.foldLess")
            : translateText("tools.foldMore", { count: lines })}
        </button>
      ) : null}
    </div>
  );
}

/** A unified diff's hunks, each line coloured by what happened to it. */
function PatchView({ patch }: { patch: string }) {
  const lines = patch
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("+++") &&
        !line.startsWith("---") &&
        !line.startsWith("Index:") &&
        !line.startsWith("===") &&
        !line.startsWith("\\"),
    );
  while (lines.at(-1) === "") lines.pop();
  return (
    <Folded text={lines.join("\n")}>
      {lines.map((line, index) => (
        <div
          // A diff's lines are its order; nothing is inserted between them.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "diff-line",
            line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : undefined,
          )}
        >
          {line === "" ? " " : line}
        </div>
      ))}
    </Folded>
  );
}

function PlanList({ items }: { items: readonly PlanItem[] }) {
  return (
    <ul className="plan-list">
      {items.map((item, index) => (
        <li
          // A plan is drawn as the call wrote it, in its order.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          data-status={item.status}
        >
          <span aria-hidden="true" className="plan-mark">
            {item.status === "completed"
              ? "■"
              : item.status === "in_progress"
                ? "▣"
                : item.status === "cancelled"
                  ? "×"
                  : "□"}
          </span>
          {item.content}
        </li>
      ))}
    </ul>
  );
}

/** A runtime's raw argument text, as the object it is when it is JSON. */
function parsed(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

/** What a runtime's subagent did inside the call: its commands and words, one line each. */
function ChildSteps({ steps }: { steps: readonly ChildStep[] }) {
  return (
    <ol className="child-steps">
      {steps.map((step, index) =>
        step.kind === "text" ? (
          // A step list is append-only, in the order the subagent worked.
          // eslint-disable-next-line react/no-array-index-key
          <li key={index} className="child-text">
            {step.text}
          </li>
        ) : (
          <li key={step.id} data-status={step.status}>
            <details>
              <summary>
                {step.name}
                {step.input === undefined || step.input === ""
                  ? ""
                  : ` · ${summarizeArgs(parsed(step.input))}`}
              </summary>
              {step.output === undefined || step.output === "" ? null : (
                <Folded text={withoutAnsi(step.output)} />
              )}
            </details>
          </li>
        ),
      )}
    </ol>
  );
}
