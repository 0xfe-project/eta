import type {
  BoardTaskDetail,
  TaskModelUsage,
  TaskRunUsage,
  TaskTokenTotals,
  TaskUsageGroup,
  TaskUsageView,
} from "@eta/client-contracts";
import type { TextStyle } from "nsh";
import type { Layout } from "../../components";
import { signal, View } from "nsh";
import { Caption, colors, Icon, Label, row } from "../../components";
import { dotSize } from "../../components/status-dot";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { clock, useHost } from "../../services/host";
import {
  breakdown,
  exactTokens,
  HintBox,
  runsText,
  tokens,
  useLiveRate,
} from "./usage";

/**
 * The Usage section of a task's page (#669): what its runs used, in total, by model and by run.
 * Always there for a task that has run, whatever the cards' setting; a task that never ran has no
 * section. A parent adds its subtasks in by default ("Include subtasks"), as its card does.
 */

/** The usage tables' columns (…Tablet on a tablet), and their header row. */
const columnWidth = {
  number: 32,
  runs: 60,
  tokens: 92,
  run: 120,
  runTablet: 96,
  started: 64,
  took: 60,
  total: 64,
  output: 56,
  rate: 56,
} as const;
const headerHeight = 24;

const OPEN = new Set(["queued", "starting", "running"]);

const plus = (a: TaskTokenTotals | null, b: TaskTokenTotals | null) => {
  if (!b) return a;
  if (!a) return { ...b };
  const reasoning =
    a.reasoning === null && b.reasoning === null
      ? null
      : (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning,
    total: a.total + b.total,
  };
};

/** The view narrowed to the task's own runs: totals and models summed again from them. */
function ownOnly(view: TaskUsageView, taskId: string): TaskUsageView {
  const runs = view.runs.filter((run) => run.taskId === taskId);
  const totals: TaskUsageGroup = { tokens: null, runs: 0, runsWithoutData: 0 };
  const models = new Map<string, TaskModelUsage>();
  for (const run of runs) {
    totals.runs += 1;
    if (!run.tokens) totals.runsWithoutData += 1;
    totals.tokens = plus(totals.tokens, run.tokens);
    for (const entry of run.models) {
      const key = `${entry.provider}\u0000${entry.model}`;
      const group = models.get(key) ?? {
        provider: entry.provider,
        model: entry.model,
        tokens: null,
        runs: 0,
        runsWithoutData: 0,
      };
      group.runs += 1;
      if (!entry.tokens) group.runsWithoutData += 1;
      group.tokens = plus(group.tokens, entry.tokens);
      models.set(key, group);
    }
  }
  return {
    ...view,
    includesSubtasks: false,
    taskIds: [taskId],
    totals,
    models: [...models.values()].sort(
      (a, b) => (b.tokens?.total ?? -1) - (a.tokens?.total ?? -1),
    ),
    runs,
  };
}

/** Models that reported something; one that only ever answered with nothing is no model to list. */
const reported = (view: TaskUsageView) =>
  view.models.filter((model) => model.tokens);

function took(run: TaskRunUsage): number | undefined {
  if (run.startedAt === null) return undefined;
  return Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt);
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A finished run's output over how long it took, tool time included: an average, not a speed. */
function average(run: TaskRunUsage): number | undefined {
  const ms = took(run);
  // Under a second says nothing about a speed.
  if (!run.tokens || !ms || ms < 1000 || OPEN.has(run.status)) return undefined;
  return Math.round((run.tokens.output / (ms / 1000)) * 10) / 10;
}

const modelOf = (run: TaskRunUsage) => {
  const first = run.models.find((model) => model.tokens) ?? run.models[0];
  if (!first) return "—";
  const more = run.models.filter((model) => model.tokens).length - 1;
  return more > 0 ? `${first.model} +${more}` : first.model;
};

export function TaskUsageSection(props: {
  item: BoardTaskDetail;
  layout: Layout;
}) {
  const host = useHost();
  const include = signal(true);
  const open = signal(true);
  const parent = () => !!props.item.children?.length;
  const full = () =>
    host.section<TaskUsageView>(`tasks.${props.item.id}`, "usage");
  const view = () => {
    const all = full();
    if (!all) return undefined;
    return parent() && include() ? all : ownOnly(all, props.item.id);
  };
  /** A task none of whose runs (its subtasks' included) got going has no section. */
  const present = () => (full()?.runs.length ?? 0) > 0;
  /** The session of a run going now, wherever it is, for the live rate. */
  const sessionOf = (run: TaskRunUsage) =>
    props.item.runs.find((entry) => entry.id === run.runId)?.sessionId ??
    host.tasks().find((task) => task.id === run.taskId)?.usage?.liveSessionId ??
    undefined;
  const going = () => view()?.runs.find((run) => OPEN.has(run.status));
  const live = useLiveRate(() => {
    const run = going();
    return run ? sessionOf(run) : undefined;
  });
  const subtasksRan = () =>
    new Set(
      (view()?.runs ?? [])
        .filter((run) => run.taskId !== props.item.id)
        .map((run) => run.taskId),
    ).size;
  /** "4 runs · 1 without token data", "2 runs · one still going", "8 runs in 4 subtasks · …". */
  const summary = (short = false) => {
    const current = view()!;
    const runs =
      parent() && include() && subtasksRan()
        ? uiText("usageRunsInSubtasks", {
            runs: runsText(current.totals.runs),
            count: subtasksRan(),
          })
        : runsText(current.totals.runs);
    if (
      current.totals.runsWithoutData &&
      current.totals.runsWithoutData < current.totals.runs
    )
      return uiText(short ? "usageRunsWithoutShort" : "usageRunsWithout", {
        runs,
        count: current.totals.runsWithoutData,
      });
    if (going() && current.totals.runs > 1)
      return uiText("usageStillGoing", { runs });
    return runs;
  };
  return (
    <If when={present() ? view() : undefined}>
      {(current) => (
        <If
          when={props.layout === "phone"}
          else={
            <WideUsage
              view={current()}
              item={props.item}
              tablet={props.layout === "tablet"}
              parent={parent()}
              include={include()}
              onInclude={include.set}
              open={open()}
              onOpen={open.set}
              live={live()}
              summary={summary()}
              sessionOf={sessionOf}
            />
          }
        >
          <PhoneUsage
            view={current()}
            parent={parent()}
            include={include()}
            onInclude={include.set}
            live={live()}
            summary={summary(true)}
          />
        </If>
      )}
    </If>
  );
}

/** The section on desktop and tablet: a folding heading, the totals, by model, by run. */
function WideUsage(props: {
  view: TaskUsageView;
  item: BoardTaskDetail;
  tablet: boolean;
  parent: boolean;
  include: boolean;
  onInclude: (on: boolean) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  live: number | undefined;
  summary: string;
  sessionOf: (run: TaskRunUsage) => string | undefined;
}) {
  const totals = () => props.view.totals.tokens;
  const models = () => reported(props.view);
  /** One model says it all on a tablet, so its table folds away there. */
  const byModel = () => models().length > (props.tablet ? 1 : 0);
  const anyGoing = () => props.view.runs.some((run) => OPEN.has(run.status));
  return (
    <View
      style={{ gap: space[12], paddingBottom: props.parent ? 0 : space[20] }}
    >
      <View style={{ ...row, gap: space[8] }}>
        <View
          role="button"
          accessibilityLabel={uiText("usageTitle")}
          accessibilityState={{ expanded: props.open }}
          onPress={() => props.onOpen(!props.open)}
          style={{ ...row, gap: space[8], cursor: "pointer" }}
        >
          <Icon
            name={props.open ? "down" : "right"}
            size={icon.sm}
            tone="muted"
          />
          <Label
            variant={props.tablet ? "body" : "subtitle"}
            weight={weight.strong}
          >
            {uiText("usageTitle")}
          </Label>
        </View>
        <If
          when={props.parent}
          else={
            <>
              <View style={{ flex: 1 }} />
              <Label variant="caption" tone="muted">
                {props.summary}
              </Label>
            </>
          }
        >
          <Label variant="caption" tone="muted" lines={1} style={{ flex: 1 }}>
            {props.summary}
          </Label>
          <Label variant="small">{uiText("usageIncludeSubtasks")}</Label>
          <ToggleSwitch
            compact
            label={uiText("usageIncludeSubtasks")}
            checked={props.include}
            onChange={props.onInclude}
          />
        </If>
      </View>
      <If when={props.open}>
        <View style={{ gap: space[16], paddingLeft: space[20] }}>
          <If
            when={totals()}
            else={
              <View style={{ gap: space[2] }}>
                <Label tone="faint">
                  {props.view.totals.runs
                    ? uiText("usageNoData")
                    : uiText("usageNoOwnRuns")}
                </Label>
                <If when={props.view.totals.runs}>
                  <Label variant="caption" tone="muted">
                    {uiText("usageNoDataWhy", {
                      runs: runsText(props.view.totals.runs),
                    })}
                  </Label>
                </If>
              </View>
            }
          >
            {(sum) => (
              <View style={{ ...row, gap: space[24], alignItems: "flex-end" }}>
                <Figure
                  label={uiText("usageTotal")}
                  value={tokens(sum().total)}
                  hint={[
                    uiText("usageExact", { count: exactTokens(sum().total) }),
                    breakdown(sum(), true),
                  ]}
                  strong
                />
                <Figure
                  label={uiText("usageInput")}
                  value={tokens(sum().input)}
                />
                <Figure
                  label={uiText("usageOutput")}
                  value={tokens(sum().output)}
                  after={
                    sum().reasoning && !props.tablet
                      ? uiText("usageReasoning", {
                          count: tokens(sum().reasoning!),
                        })
                      : undefined
                  }
                />
                <If
                  when={props.tablet}
                  else={
                    <>
                      <Figure
                        label={uiText("usageCacheRead")}
                        value={tokens(sum().cacheRead)}
                      />
                      <Figure
                        label={uiText("usageCacheWrite")}
                        value={tokens(sum().cacheWrite)}
                      />
                    </>
                  }
                >
                  <Figure
                    label={uiText("usageCache")}
                    value={tokens(sum().cacheRead + sum().cacheWrite)}
                  />
                </If>
                <If when={props.live}>
                  {(rate) => (
                    <Figure
                      label={uiText("usageNow")}
                      value={uiText("usageRate", { rate: rate().toFixed(1) })}
                      tone="green"
                    />
                  )}
                </If>
              </View>
            )}
          </If>
          <If when={byModel()}>
            <Table
              columns={[
                { title: uiText("usageByModel"), flex: true },
                { title: uiText("usageRunsColumn"), width: columnWidth.runs },
                { title: uiText("usageInput"), width: columnWidth.tokens },
                { title: uiText("usageOutput"), width: columnWidth.tokens },
                { title: uiText("usageCache"), width: columnWidth.tokens },
                { title: uiText("usageTotal"), width: columnWidth.tokens },
              ]}
            >
              <Each of={models()} key={(m) => `${m.provider}/${m.model}`}>
                {(model) => (
                  <TableRow>
                    <View
                      style={{
                        ...row,
                        flex: 1,
                        flexBasis: 0,
                        minWidth: 0,
                        gap: space[4],
                      }}
                    >
                      <Label variant="small" lines={1}>
                        {model().model}
                      </Label>
                      <Label variant="caption" tone="muted" lines={1}>
                        {model().provider}
                      </Label>
                    </View>
                    <Cell width={columnWidth.runs}>{String(model().runs)}</Cell>
                    <Cell width={columnWidth.tokens}>
                      {tokens(model().tokens?.input)}
                    </Cell>
                    <Cell width={columnWidth.tokens}>
                      {tokens(model().tokens?.output)}
                    </Cell>
                    <Cell width={columnWidth.tokens}>
                      {tokens(
                        model().tokens
                          ? model().tokens!.cacheRead +
                              model().tokens!.cacheWrite
                          : undefined,
                      )}
                    </Cell>
                    <Cell width={columnWidth.tokens} strong>
                      {tokens(model().tokens?.total)}
                    </Cell>
                  </TableRow>
                )}
              </Each>
            </Table>
          </If>
          <RunsTable
            view={props.view}
            item={props.item}
            tablet={props.tablet}
            parent={props.parent && props.include}
            sessionOf={props.sessionOf}
          />
          <Label variant="caption" tone="muted">
            {props.parent && props.include
              ? uiText("usageFootnoteFold")
              : anyGoing()
                ? uiText("usageFootnoteLive")
                : uiText("usageFootnote")}
          </Label>
        </View>
      </If>
    </View>
  );
}

/** By run: who, which model, when, how long, tokens, output and tok/s. */
function RunsTable(props: {
  view: TaskUsageView;
  item: BoardTaskDetail;
  tablet: boolean;
  parent: boolean;
  sessionOf: (run: TaskRunUsage) => string | undefined;
}) {
  const host = useHost();
  const unfolded = signal<string[]>([]);
  /** A parent's runs: a subtask with more than three folds into one line until opened. */
  const lines = (): { run: TaskRunUsage; folded?: TaskRunUsage[] }[] => {
    const runs = props.view.runs;
    if (!props.parent) return runs.map((run) => ({ run }));
    const count = new Map<string, number>();
    for (const run of runs)
      count.set(run.taskId, (count.get(run.taskId) ?? 0) + 1);
    const seen = new Set<string>();
    return runs.flatMap((run) => {
      if ((count.get(run.taskId) ?? 0) <= 3 || unfolded().includes(run.taskId))
        return [{ run }];
      if (seen.has(run.taskId)) return [];
      seen.add(run.taskId);
      return [{ run, folded: runs.filter((r) => r.taskId === run.taskId) }];
    });
  };
  const numberOf = (taskId: string) =>
    host.tasks().find((task) => task.id === taskId)?.number ??
    props.item.children?.find((child) => child.taskId === taskId)?.number;
  const columns = () => [
    ...(props.parent
      ? [{ title: "", width: columnWidth.number, left: true }]
      : []),
    {
      title: props.tablet ? uiText("usageRunColumn") : uiText("usageByRun"),
      left: true,
      width: props.tablet ? columnWidth.runTablet : columnWidth.run,
    },
    { title: uiText("usageModel"), flex: true },
    ...(!props.tablet && !props.parent
      ? [
          {
            title: uiText("usageStarted"),
            width: columnWidth.started,
            left: true,
          },
        ]
      : []),
    { title: uiText("usageTook"), width: columnWidth.took },
    { title: uiText("usageTokens"), width: columnWidth.total },
    ...(!props.tablet
      ? [{ title: uiText("usageOutput"), width: columnWidth.output }]
      : []),
    { title: uiText("usageRateColumn"), width: columnWidth.rate },
  ];
  return (
    <Table columns={columns()}>
      <Each of={lines()} key={(line) => line.run.runId}>
        {(line) => (
          <If
            when={line().folded}
            else={
              <RunLineRow
                run={line().run}
                number={props.parent ? numberOf(line().run.taskId) : undefined}
                tablet={props.tablet}
                parent={props.parent}
                session={props.sessionOf(line().run)}
              />
            }
          >
            {(runs) => {
              const sum = () =>
                runs().reduce<TaskTokenTotals | null>(
                  (acc, run) => plus(acc, run.tokens),
                  null,
                );
              return (
                <View
                  role="button"
                  accessibilityLabel={`#${numberOf(line().run.taskId)}`}
                  onPress={() =>
                    unfolded.update((ids) => [...ids, line().run.taskId])
                  }
                  style={{
                    ...row,
                    height: control.md,
                    gap: space[4],
                    cursor: "pointer",
                  }}
                >
                  <Icon name="right" size={icon.sm} tone="muted" />
                  <Label variant="small" tone="muted" lines={1}>
                    {[
                      `#${numberOf(line().run.taskId) ?? ""}`,
                      runsText(runs().length),
                      sum()
                        ? uiText("usageTok", { count: tokens(sum()!.total) })
                        : uiText("usageNoData"),
                      ...(runs().some((run) => !run.tokens) && sum()
                        ? [
                            uiText("usageWithoutData", {
                              count: runs().filter((run) => !run.tokens).length,
                            }),
                          ]
                        : []),
                    ].join(" · ")}
                  </Label>
                </View>
              );
            }}
          </If>
        )}
      </Each>
    </Table>
  );
}

function RunLineRow(props: {
  run: TaskRunUsage;
  number?: number;
  tablet: boolean;
  parent: boolean;
  session: string | undefined;
}) {
  const host = useHost();
  const going = () => OPEN.has(props.run.status);
  const rate = useLiveRate(() => (going() ? props.session : undefined));
  const name = () =>
    (props.run.agentId && host.agent(props.run.agentId)?.name) || "—";
  return (
    <TableRow>
      <If when={props.parent}>
        <Cell
          width={columnWidth.number}
          align="left"
          tone="muted"
          variant="caption"
        >
          {props.number === undefined ? "" : `#${props.number}`}
        </Cell>
      </If>
      <View
        style={{
          ...row,
          width: props.tablet ? columnWidth.runTablet : columnWidth.run,
          gap: space[4],
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <Label variant="small" lines={1} style={{ flexShrink: 1 }}>
          {name()}
        </Label>
        <If when={props.run.mentioned}>
          <Label variant="caption" tone="muted">
            {uiText("usageMentioned")}
          </Label>
        </If>
        <If when={going()}>
          <View style={{ ...row, gap: space[4] }}>
            <BlueSquare />
            <If when={!props.tablet}>
              <Label variant="caption" tone="blue">
                {uiText("usageRunning")}
              </Label>
            </If>
          </View>
        </If>
      </View>
      <Label
        variant="small"
        tone="mutedInk"
        lines={1}
        style={{ flex: 1, flexBasis: 0, minWidth: 0 }}
      >
        {props.run.tokens ? modelOf(props.run) : "—"}
      </Label>
      <If when={!props.tablet && !props.parent}>
        <Cell width={columnWidth.started} align="left" tone="mutedInk">
          {props.run.startedAt ? clock(props.run.startedAt) : "—"}
        </Cell>
      </If>
      <Cell width={columnWidth.took} tone="mutedInk">
        {duration(took(props.run))}
      </Cell>
      <If
        when={props.run.tokens}
        else={
          <Label
            variant="small"
            tone="faint"
            style={{
              width: props.tablet
                ? columnWidth.total + columnWidth.rate + space[8]
                : columnWidth.total +
                  columnWidth.output +
                  columnWidth.rate +
                  space[16],
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            {uiText("usageNoData")}
          </Label>
        }
      >
        {(sum) => (
          <>
            <Cell width={columnWidth.total} strong>
              {tokens(sum().total)}
            </Cell>
            <If when={!props.tablet}>
              <Cell width={columnWidth.output} tone="mutedInk">
                {tokens(sum().output)}
              </Cell>
            </If>
            <Cell
              width={columnWidth.rate}
              tone={going() && rate() ? "green" : "mutedInk"}
            >
              {going()
                ? rate()
                  ? rate()!.toFixed(1)
                  : "—"
                : (average(props.run)?.toFixed(1) ?? "—")}
            </Cell>
          </>
        )}
      </If>
    </TableRow>
  );
}

function BlueSquare() {
  const c = colors();
  return (
    <View
      style={{ width: dotSize, height: dotSize, backgroundColor: c().blue }}
    />
  );
}

/** One figure of the totals: a muted caption over the number. */
function Figure(props: {
  label: string;
  value: string;
  strong?: boolean;
  after?: string;
  tone?: "green";
  hint?: string[];
}) {
  return (
    <View
      tooltip={props.hint ? <HintBox lines={props.hint} /> : undefined}
      style={{ gap: space[2] }}
    >
      <Label variant="caption" tone="mutedInk">
        {props.label}
      </Label>
      <View style={{ ...row, gap: space[4], alignItems: "baseline" }}>
        <Label
          variant={props.strong ? "subtitle" : "body"}
          weight={props.strong ? weight.strong : weight.regular}
          tone={props.tone ?? "ink"}
        >
          {props.value}
        </Label>
        <If when={props.after}>
          <Label variant="caption" tone="muted">
            {props.after}
          </Label>
        </If>
      </View>
    </View>
  );
}

interface Column {
  title: string;
  width?: number;
  flex?: boolean;
  left?: boolean;
}

function Table(props: { columns: Column[]; children?: unknown }) {
  const c = colors();
  return (
    <View>
      <View
        style={{
          ...row,
          height: headerHeight,
          gap: space[8],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Each of={props.columns}>
          {(column) => (
            <Label
              variant="caption"
              tone="mutedInk"
              lines={1}
              style={
                column().flex
                  ? { flex: 1, flexBasis: 0, minWidth: 0 }
                  : {
                      width: column().width,
                      flexShrink: 0,
                      textAlign: column().left ? "left" : "right",
                    }
              }
            >
              {column().title}
            </Label>
          )}
        </Each>
      </View>
      {props.children as never}
    </View>
  );
}

function TableRow(props: { children?: unknown }) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        height: control.md,
        gap: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      {props.children as never}
    </View>
  );
}

function Cell(props: {
  width: number;
  children?: string;
  strong?: boolean;
  align?: "left" | "right";
  tone?: "muted" | "mutedInk" | "green";
  variant?: "small" | "caption";
  style?: TextStyle;
}) {
  return (
    <Label
      variant={props.variant ?? "small"}
      weight={weight.regular}
      tone={props.tone ?? "ink"}
      lines={1}
      style={{
        width: props.width,
        flexShrink: 0,
        textAlign: props.align ?? "right",
        ...props.style,
      }}
    >
      {props.children}
    </Label>
  );
}

/** The phone's section: one total, its split, the models, and a tap for the exact count. */
function PhoneUsage(props: {
  view: TaskUsageView;
  parent: boolean;
  include: boolean;
  onInclude: (on: boolean) => void;
  live: number | undefined;
  summary: string;
}) {
  const c = colors();
  const exact = signal(false);
  const all = signal(false);
  const models = () => reported(props.view);
  /** Two models and a line for the rest; a single one left over is shown rather than folded. */
  const folds = () => !all() && models().length > 3;
  const shownModels = () => (folds() ? models().slice(0, 2) : models());
  const rest = () => (folds() ? models().slice(2) : []);
  return (
    <View style={{ gap: space[4] }}>
      <View style={{ ...row, gap: space[8] }}>
        <Caption text={uiText("usageTitle")} style={{ flex: 1 }} />
        <If when={props.parent}>
          <Label variant="small">{uiText("usageIncludeSubtasks")}</Label>
          <ToggleSwitch
            compact
            label={uiText("usageIncludeSubtasks")}
            checked={props.include}
            onChange={props.onInclude}
          />
        </If>
      </View>
      <If
        when={props.view.totals.tokens}
        else={
          <View style={{ gap: space[4] }}>
            <Label variant="subtitle" tone="faint">
              {props.view.totals.runs
                ? uiText("usageNoData")
                : uiText("usageNoOwnRuns")}
            </Label>
            <If when={props.view.totals.runs}>
              <Label variant="small" tone="muted">
                {uiText("usageNoDataWhy", {
                  runs: runsText(props.view.totals.runs),
                })}
              </Label>
            </If>
          </View>
        }
      >
        {(sum) => (
          <>
            <View style={{ ...row, gap: space[8], alignItems: "baseline" }}>
              <View
                role="button"
                accessibilityLabel={uiText("usageExact", {
                  count: exactTokens(sum().total),
                })}
                onPress={() => exact.set(!exact())}
                style={{ cursor: "pointer" }}
              >
                <Label variant="subtitle" weight={weight.strong}>
                  {uiText("usageTok", { count: tokens(sum().total) })}
                </Label>
              </View>
              <View style={{ flex: 1 }} />
              <If
                when={props.live}
                else={
                  <Label variant="small" tone="muted">
                    {props.summary}
                  </Label>
                }
              >
                {(rate) => (
                  <Label variant="small" tone="green">
                    {uiText("usageRateNow", { rate: rate().toFixed(1) })}
                  </Label>
                )}
              </If>
            </View>
            <If when={exact()}>
              <View style={{ alignSelf: "flex-start" }}>
                <HintBox
                  lines={[
                    uiText("usageExact", { count: exactTokens(sum().total) }),
                    breakdown(sum(), true),
                  ]}
                />
              </View>
            </If>
            <Label variant="small" tone="muted">
              {breakdown(sum())}
            </Label>
            <If
              when={models().length > 1 && props.parent}
              else={
                <Label variant="small" tone="muted" lines={2}>
                  {models().length === 1
                    ? `${models()[0]!.model} · ${runsText(props.view.totals.runs)}`
                    : models()
                        .map((model) => model.model)
                        .join(", ")}
                </Label>
              }
            >
              <View>
                <Each
                  of={shownModels()}
                  key={(m) => `${m.provider}/${m.model}`}
                >
                  {(model) => (
                    <View
                      style={{
                        ...row,
                        height: space[32],
                        gap: space[8],
                        borderBottomWidth: 1,
                        borderColor: c().border,
                      }}
                    >
                      <Label variant="small" lines={1} style={{ flex: 1 }}>
                        {model().model}
                      </Label>
                      <Label variant="caption" tone="muted">
                        {runsText(model().runs)}
                      </Label>
                      <Label
                        variant="small"
                        style={{
                          width: columnWidth.output,
                          textAlign: "right",
                        }}
                      >
                        {tokens(model().tokens?.total)}
                      </Label>
                    </View>
                  )}
                </Each>
                <If when={rest().length}>
                  <View
                    role="button"
                    accessibilityLabel={uiText("usageMoreModels", {
                      count: rest().length,
                    })}
                    onPress={() => all.set(true)}
                    style={{
                      ...row,
                      height: space[32],
                      gap: space[8],
                      cursor: "pointer",
                    }}
                  >
                    <Label variant="small" tone="muted" style={{ flex: 1 }}>
                      {uiText("usageMoreModels", { count: rest().length })}
                    </Label>
                    <Label variant="small">
                      {tokens(
                        rest().reduce(
                          (acc, model) => acc + (model.tokens?.total ?? 0),
                          0,
                        ),
                      )}
                    </Label>
                    <Icon name="right" size={icon.sm} tone="muted" />
                  </View>
                </If>
              </View>
            </If>
          </>
        )}
      </If>
    </View>
  );
}

/** A run's tokens at the end of its row on the phone: the total, then live or average tok/s. */
export function PhoneRunTokens(props: {
  taskId: string;
  runId: string;
  session: string | null;
}) {
  const host = useHost();
  const run = () =>
    host
      .section<TaskUsageView>(`tasks.${props.taskId}`, "usage")
      ?.runs.find((entry) => entry.runId === props.runId);
  const going = () => !!run() && OPEN.has(run()!.status);
  const rate = useLiveRate(() => (going() ? props.session : undefined));
  return (
    <If when={run()}>
      {(current) => (
        <View style={{ alignItems: "flex-end", gap: 1, flexShrink: 0 }}>
          <Label variant="caption" tone={current().tokens ? "ink" : "faint"}>
            {current().tokens
              ? uiText("usageTok", { count: tokens(current().tokens!.total) })
              : uiText("usageNoDataShort")}
          </Label>
          <If
            when={going()}
            else={
              <If when={average(current())}>
                {(value) => (
                  <Label variant="caption" tone="muted">
                    {uiText("usageRateAvg", { rate: value().toFixed(1) })}
                  </Label>
                )}
              </If>
            }
          >
            <If when={rate()}>
              {(value) => (
                <Label variant="caption" tone="green">
                  {uiText("usageRate", { rate: value().toFixed(1) })}
                </Label>
              )}
            </If>
          </If>
        </View>
      )}
    </If>
  );
}
