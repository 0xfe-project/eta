import type { ReactNode } from "react";
import type { RunStep, RunTiming, StepKind } from "@/lib/run-timing";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  clock,
  kindTotals,
  STEP_KINDS,
  stepDuration,
  stripSegments,
} from "@/lib/run-timing";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-identity";

/** Each kind's colour, from the theme (`--run-*` in styles.css). Coarse "tool" takes the commands'. */
const KIND_COLOR: Record<StepKind, string> = {
  model: "var(--run-model)",
  shell: "var(--run-shell)",
  read: "var(--run-read)",
  edit: "var(--run-edit)",
  tool: "var(--run-shell)",
  other: "var(--run-other)",
};

/** A step's fill: its kind's colour, striped while it is still going. */
const fillOf = (step: RunStep): string =>
  step.running
    ? `repeating-linear-gradient(135deg, ${KIND_COLOR[step.kind]} 0 3px, transparent 3px 6px)`
    : KIND_COLOR[step.kind];

const percent = (part: number, whole: number): string =>
  `${((Math.max(0, part) / whole) * 100).toFixed(3)}%`;

/**
 * The top of a run's dialog: who, how it is going, and — when the transcript says when things
 * happened — where the time went. One line (face, name, status, the actions), then the strip.
 */
export function RunHeader({
  agentId,
  name,
  status,
  actions,
  timing,
  onPick,
}: {
  agentId: string | null | undefined;
  name: string;
  /** After the name, quieter: the state and the time. */
  status: ReactNode;
  /** At the end of the line, before the dialog's close. */
  actions?: ReactNode;
  timing: RunTiming | undefined;
  /** A step was picked: the log goes to it. */
  onPick: (step: RunStep) => void;
}) {
  const { t: translateText } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return (
    <>
      <div className="flex h-7 min-w-0 items-center gap-2 pr-7">
        {agentId ? (
          <AgentAvatar agent={{ id: agentId }} className="size-[18px]" />
        ) : null}
        <span className="min-w-0 shrink truncate font-medium">{name}</span>
        <span className="flex min-w-0 shrink-[2] items-center gap-1.5 truncate text-xs text-muted-foreground">
          {status}
        </span>
        <span className="flex-1" />
        {timing === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((was) => !was)}
          >
            {expanded
              ? translateText("run.collapse")
              : translateText("run.expand")}
            <CaretDownIcon
              aria-hidden="true"
              className={cn("size-3", expanded && "rotate-180")}
            />
          </Button>
        )}
        {actions}
      </div>
      {timing === undefined ? null : (
        <RunTimeline
          id={panelId}
          timing={timing}
          expanded={expanded}
          onPick={(step, from) => {
            if (from === "strip") setExpanded(true);
            onPick(step);
          }}
        />
      )}
    </>
  );
}

interface Tip {
  index: number;
  left: number;
  top: number;
}

/**
 * Where a run's time went: a strip as wide as the dialog, a segment per step sized by how long it
 * took and coloured by what it was, a legend with each kind's total under it, and — expanded — a
 * waterfall with a row per step against the run's clock, where calls made together start together.
 * Hovering or focusing a step says what it was; picking one sends the log to it. Both the strip
 * and the waterfall are one tab stop, walked with the arrow keys.
 */
export function RunTimeline({
  id,
  timing,
  expanded,
  onPick,
}: {
  id: string;
  timing: RunTiming;
  expanded: boolean;
  onPick: (step: RunStep, from: "strip" | "waterfall") => void;
}) {
  const { t: translateText } = useTranslation("common");
  const boxRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>();
  const [picked, setPicked] = useState<number>();
  // Where Tab lands in the strip and in the waterfall: the step last walked to.
  const [stripAt, setStripAt] = useState(0);
  const [rowAt, setRowAt] = useState(0);
  const total = timing.end - timing.start;
  const segments = stripSegments(timing);
  const totals = kindTotals(timing.steps);
  const kindLabel = (kind: StepKind) => translateText(`run.kinds.${kind}`);
  const nameOf = (step: RunStep) => step.name || kindLabel("model");
  const tookOf = (step: RunStep) =>
    step.running
      ? translateText("run.running")
      : translateText("run.took", {
          duration: stepDuration(step.end - step.start),
        });
  const label = (step: RunStep) => {
    const name = nameOf(step);
    const kind = kindLabel(step.kind);
    const start = clock(step.start - timing.start);
    const took = tookOf(step);
    return step.detail === ""
      ? translateText("run.stepPlain", { name, kind, start, took })
      : translateText("run.step", {
          name,
          kind,
          detail: step.detail,
          start,
          took,
        });
  };
  const summary = translateText("run.summary", {
    count: timing.steps.length,
    duration: clock(total),
  });

  const show = (index: number, target: HTMLElement) => {
    const box = boxRef.current;
    if (!box) return;
    const outer = box.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    setTip({
      index,
      left: Math.max(
        0,
        Math.min(rect.left - outer.left, outer.width - 20 * 16),
      ),
      top: rect.bottom - outer.top + 4,
    });
  };
  const hide = () => setTip(undefined);
  const pick = (index: number, from: "strip" | "waterfall") => {
    setPicked(index);
    onPick(timing.steps[index]!, from);
  };
  const tipStep = tip === undefined ? undefined : timing.steps[tip.index];

  return (
    <div ref={boxRef} className="relative">
      <Roving
        role="toolbar"
        aria-label={summary}
        orientation="horizontal"
        onCurrent={setStripAt}
        className="relative mt-2 h-2.5"
      >
        {segments.map(({ step, index, from, to }, at) => (
          <button
            key={index}
            type="button"
            tabIndex={at === Math.min(stripAt, segments.length - 1) ? 0 : -1}
            data-step={index}
            aria-label={label(step)}
            aria-current={picked === index ? "step" : undefined}
            className="run-segment absolute inset-y-0"
            style={{
              left: percent(from - timing.start, total),
              width: percent(to - from, total),
              background: fillOf(step),
            }}
            onClick={() => pick(index, "strip")}
            onPointerEnter={(event) => show(index, event.currentTarget)}
            onPointerLeave={hide}
            onFocus={(event) => show(index, event.currentTarget)}
            onBlur={hide}
          />
        ))}
      </Roving>
      {/* Always shown: two of the light colours are under 3:1 on white, so the words carry it. */}
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {STEP_KINDS.filter((kind) => totals.has(kind)).map((kind) => (
          <li key={kind} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0"
              style={{ background: KIND_COLOR[kind] }}
            />
            {kindLabel(kind)}
            <span className="font-medium text-foreground tabular-nums">
              {stepDuration(totals.get(kind)!)}
            </span>
          </li>
        ))}
      </ul>
      <div id={id} hidden={!expanded}>
        {expanded ? (
          <div className="mt-2 border-t pt-1.5">
            <div
              aria-hidden="true"
              className="run-waterfall-grid text-[10px] text-faint"
            >
              <span />
              <span className="relative h-3.5 border-b">
                {[0, 0.25, 0.5, 0.75, 1].map((at) => (
                  <span
                    key={at}
                    className={cn(
                      "absolute",
                      at === 0
                        ? ""
                        : at === 1
                          ? "-translate-x-full"
                          : "-translate-x-1/2",
                    )}
                    style={{ left: `${at * 100}%` }}
                  >
                    {clock(at * total)}
                  </span>
                ))}
              </span>
              <span />
            </div>
            <Roving
              as="ol"
              aria-label={translateText("run.steps")}
              orientation="vertical"
              onCurrent={setRowAt}
              className="run-waterfall max-h-[15.5rem] overflow-y-auto overscroll-y-auto"
            >
              {timing.steps.map((step, index) => (
                <li key={`${step.name}|${step.blocks[0] ?? ""}|${step.start}`}>
                  <button
                    type="button"
                    tabIndex={
                      index === Math.min(rowAt, timing.steps.length - 1)
                        ? 0
                        : -1
                    }
                    data-step={index}
                    aria-label={label(step)}
                    aria-current={picked === index ? "step" : undefined}
                    className="run-waterfall-grid run-waterfall-row w-full text-left text-xs"
                    onClick={() => pick(index, "waterfall")}
                    onPointerEnter={(event) => show(index, event.currentTarget)}
                    onPointerLeave={hide}
                    onFocus={(event) => show(index, event.currentTarget)}
                    onBlur={hide}
                  >
                    <span className="truncate text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {nameOf(step)}
                      </span>
                      {step.detail === "" ? "" : ` · ${step.detail}`}
                    </span>
                    <span className="relative h-3">
                      <span
                        className="absolute inset-y-0.5 min-w-0.5"
                        style={{
                          left: percent(step.start - timing.start, total),
                          width: percent(step.end - step.start, total),
                          background: fillOf(step),
                        }}
                      />
                    </span>
                    <span className="text-right text-muted-foreground tabular-nums">
                      {stepDuration(step.end - step.start)}
                    </span>
                  </button>
                </li>
              ))}
            </Roving>
          </div>
        ) : null}
      </div>
      {tipStep === undefined || tip === undefined ? null : (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 max-w-80 border border-border-strong bg-popover px-2 py-1.5 text-xs text-popover-foreground"
          style={{ left: tip.left, top: tip.top }}
        >
          <div>
            <span className="font-medium">{nameOf(tipStep)}</span>{" "}
            <span className="text-muted-foreground">
              {kindLabel(tipStep.kind)}
            </span>
          </div>
          {tipStep.detail === "" ? null : (
            <div className="text-muted-foreground wrap-anywhere">
              {tipStep.detail}
            </div>
          )}
          <div className="tabular-nums">
            {translateText("run.startsAt", {
              time: clock(tipStep.start - timing.start),
            })}
            {" · "}
            {tookOf(tipStep)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Buttons that are one tab stop: the arrow keys (Home and End too) walk them, and the one last
 * reached is where Tab comes back to. The caller gives that one `tabIndex` 0 (`current`).
 */
function Roving({
  orientation,
  onCurrent,
  children,
  as: Tag = "div",
  ...rest
}: {
  orientation: "horizontal" | "vertical";
  onCurrent: (at: number) => void;
  children: ReactNode;
  as?: "div" | "ol";
  role?: "toolbar";
  className: string;
  "aria-label": string;
}) {
  const ref = useRef<HTMLElement>(null);
  const buttons = () => [
    ...(ref.current?.querySelectorAll<HTMLButtonElement>("button[data-step]") ??
      []),
  ];
  const [back, forward] =
    orientation === "horizontal"
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
  return (
    <Tag
      ref={ref as never}
      {...rest}
      {...(rest.role === "toolbar" ? { "aria-orientation": orientation } : {})}
      onFocus={(event: React.FocusEvent) => {
        const at = buttons().indexOf(event.target as HTMLButtonElement);
        if (at >= 0) onCurrent(at);
      }}
      onKeyDown={(event: React.KeyboardEvent) => {
        const all = buttons();
        const at = all.indexOf(event.target as HTMLButtonElement);
        if (at < 0) return;
        const next =
          event.key === back
            ? Math.max(0, at - 1)
            : event.key === forward
              ? Math.min(all.length - 1, at + 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? all.length - 1
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        all[next]?.focus();
      }}
    >
      {children}
    </Tag>
  );
}
