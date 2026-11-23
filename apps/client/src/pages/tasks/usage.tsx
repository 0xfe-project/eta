import type {
  BoardTaskView,
  TaskTokenTotals,
  TaskUsageBrief,
} from "@eta/client-contracts";
import type { TextStyle, ViewStyle } from "nsh";
import type { TextVariant } from "../../components";
import { signal, Storage, View } from "nsh";
import { colors, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { followSession, useHost } from "../../services/host";

/**
 * A task's token usage where tasks are listed (#669): the board's cards, the list's rows, the
 * chat's task cards and the panel's Tasks rows. One setting, off by default, shows it in all of
 * them; the task's own page shows its Usage section either way.
 */

const shownKey = "eta.tasks.usage";
const shown = signal(false);
let loaded = false;
let touched = false;

function load() {
  if (loaded) return;
  loaded = true;
  void Storage.getItem(shownKey)
    .then((value) => {
      if (!touched) shown.set(value === "true");
    })
    .catch(() => {});
}

/** Whether cards and rows say what their tasks used. */
export function usageShown(): boolean {
  load();
  return shown();
}

export function setUsageShown(next: boolean): void {
  load();
  touched = true;
  shown.set(next);
  void Storage.setItem(shownKey, String(next)).catch(() => {});
}

/** 2,431,906 → "2.4M", 12,345 → "12.3k": a token count as the members' sidebar says it. */
export function tokens(count: number | undefined): string {
  return count === undefined
    ? "—"
    : count >= 1_000_000
      ? `${(count / 1_000_000).toFixed(1)}M`
      : count >= 1_000
        ? `${(count / 1_000).toFixed(1)}k`
        : String(count);
}

/** The exact count, grouped: what a hover (a tap on a phone) shows. */
export function exactTokens(count: number): string {
  return count.toLocaleString(formatLocale());
}

export function runsText(count: number): string {
  return count === 1
    ? uiText("usageRun")
    : uiText("usageRuns", { count: String(count) });
}

/** "in 1.2M · out 98.1k · cache 1.1M", or the exact counts. */
export function breakdown(totals: TaskTokenTotals, exact = false): string {
  const say = exact ? exactTokens : tokens;
  return uiText("usageBreakdown", {
    input: say(totals.input),
    output: say(totals.output),
    cache: say(totals.cacheRead + totals.cacheWrite),
  });
}

/**
 * What a card says for a task: its own runs, or for a parent (which does no work itself) its
 * subtasks' together. Undefined when none of them ran, or from a host that does not say.
 */
export function cardUsage(
  task: BoardTaskView,
): { brief: TaskUsageBrief; withSubtasks: boolean } | undefined {
  if (task.subtasks?.total && task.usageWithSubtasks)
    return { brief: task.usageWithSubtasks, withSubtasks: true };
  return task.usage ? { brief: task.usage, withSubtasks: false } : undefined;
}

/**
 * The live output rate of a session, read from its `metrics` the way the members' sidebar reads
 * it. Only eta's own loop measures one: on Claude Code, Codex or an ACP agent there is none, and
 * nothing is said. Undefined when there is no rate to say.
 */
export function useLiveRate(session: () => string | null | undefined) {
  const host = useHost();
  followSession(() => session() ?? undefined);
  return () => {
    const id = session();
    if (!id) return undefined;
    const rate = host.section<{ tokensPerSec?: number }>(
      `sessions.${id}`,
      "metrics",
    )?.tokensPerSec;
    if (!rate || !Number.isFinite(rate)) return undefined;
    return Math.round(rate * 10) / 10;
  };
}

/** "4 runs", or "4 runs · 1 without token data". */
function runsSummary(
  group: { runs: number; runsWithoutData: number },
  short = false,
): string {
  return group.runsWithoutData && group.runsWithoutData < group.runs
    ? uiText(short ? "usageRunsWithoutShort" : "usageRunsWithout", {
        runs: runsText(group.runs),
        count: group.runsWithoutData,
      })
    : runsText(group.runs);
}

/** The lines of a usage hover: exact total and runs, the split, the models. */
function usageHint(brief: TaskUsageBrief): string[] {
  if (!brief.tokens) return [uiText("usageNoData"), runsText(brief.runs)];
  return [
    `${uiText("usageExact", { count: exactTokens(brief.tokens.total) })} · ${runsSummary(brief)}`,
    breakdown(brief.tokens, true),
    ...(brief.model
      ? [brief.models > 1 ? `${brief.model} +${brief.models - 1}` : brief.model]
      : []),
  ];
}

/** A dark tooltip of a few lines, as the context ring's. */
export function HintBox(props: { lines: string[] }) {
  const c = colors();
  return (
    <View
      style={{
        paddingHorizontal: space[12],
        paddingVertical: space[8],
        gap: space[2],
        backgroundColor: c().ink,
      }}
    >
      <Each of={props.lines}>
        {(line) => (
          <Label variant="small" tone="canvas" weight={weight.regular}>
            {line()}
          </Label>
        )}
      </Each>
    </View>
  );
}

/** "2.4M tok · gpt-5.1-codex +1", "4.8M tok · with subtasks", or "No token data". */
export function usageText(
  usage: { brief: TaskUsageBrief; withSubtasks: boolean },
  options: { model?: boolean; short?: boolean } = {},
): string {
  const { brief, withSubtasks } = usage;
  if (!brief.tokens)
    return uiText(options.short ? "usageNoDataShort" : "usageNoData");
  const parts = [uiText("usageTok", { count: tokens(brief.tokens.total) })];
  if (withSubtasks) parts.push(uiText("usageWithSubtasks"));
  else if (options.model && brief.model)
    parts.push(
      brief.models > 1 ? `${brief.model} +${brief.models - 1}` : brief.model,
    );
  return parts.join(" · ");
}

/**
 * A task's usage on one line: tokens (and the model, where there is room), then the live rate in
 * green while a run of eta's own loop is going. Nothing for a task that never ran, nor while the
 * setting is off (unless `always`).
 */
export function UsageLine(props: {
  task: BoardTaskView;
  /** Name the main model too: on desktop. */
  model?: boolean;
  /** Say the live rate while a run is going. */
  rate?: boolean;
  variant?: TextVariant;
  /** "No data" for "No token data", where the line is narrow. */
  short?: boolean;
  /** Ink numbers (the panel's and the chat card's), else muted. */
  tone?: "muted" | "mutedInk" | "ink";
  style?: ViewStyle;
  textStyle?: TextStyle;
}) {
  const usage = () => (usageShown() ? cardUsage(props.task) : undefined);
  const rate = useLiveRate(() =>
    props.rate && usage() && !usage()!.withSubtasks
      ? usage()!.brief.liveSessionId
      : undefined,
  );
  return (
    <If when={usage()}>
      {(current) => (
        <View
          tooltip={<HintBox lines={usageHint(current().brief)} />}
          style={{ ...row, gap: space[4], minWidth: 0, ...props.style }}
        >
          <Label
            variant={props.variant ?? "small"}
            tone={current().brief.tokens ? (props.tone ?? "muted") : "faint"}
            lines={1}
            style={{ flexShrink: 1, minWidth: 0, ...props.textStyle }}
          >
            {usageText(current(), { model: props.model, short: props.short })}
          </Label>
          <If when={rate()}>
            {(value) => (
              <Label
                variant={props.variant ?? "small"}
                tone="green"
                style={{ flexShrink: 0 }}
              >
                {uiText("usageRate", { rate: value().toFixed(1) })}
              </Label>
            )}
          </If>
        </View>
      )}
    </If>
  );
}
