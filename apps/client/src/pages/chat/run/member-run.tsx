import type {
  MessageView,
  SessionViewSections,
  TaskRunView,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { logBlocks, runFromOf } from "@eta/client-contracts";
import { cleanup, computed, effect, Scroll, signal, View } from "nsh";
import { Button, colors, grow, Icon, Label, row } from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import { CloseButton } from "../../../components/navigation-buttons";
import { StatusDot } from "../../../components/status-dot";
import { formatLocale, uiText } from "../../../i18n";
import { clock, follow, useHost } from "../../../services/host";
import { runDuration, runKinds, transcriptTiming } from "./run-timing";
import { TranscriptLine } from "./transcript-line";

function runDate(at: number) {
  const date = new Date(at);
  const day =
    date.toDateString() === new Date().toDateString()
      ? uiText("todayDate")
      : date.toLocaleDateString(formatLocale(), {
          month: "short",
          day: "numeric",
        });
  if (formatLocale() === "zh-CN") return `${day} ${clock(at)}`;
  const hour = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
}

export function MemberRun(props: {
  session: string;
  agentId: string;
  phone: boolean;
  reply?: MessageView;
  taskRun?: TaskRunView;
  nextRunAt?: number;
  executorName?: string;
  /** Replaces the date and thinking level after the name, such as a task run's caption. */
  meta?: string;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const expanded = signal(false);
  const selected = signal("");
  const open = signal<Record<string, boolean>>({});
  const now = signal(Date.now());
  const refs = new Map<string, ViewRef>();
  const target = `sessions.${props.session}`;
  follow(() => target);
  const transcript = () =>
    host.section<TranscriptSection>(target, "transcript");
  const core = () => host.section<ViewCore>(target, "core");
  const systems = () =>
    host.section<SessionViewSections["systems"]>(target, "systems");
  const thinking = () =>
    host.section<SessionViewSections["model"]>(target, "model")?.thinkingLevel;
  const online = () => host.state().status === "open";
  const running = () =>
    core()?.running === true &&
    (!props.taskRun || props.taskRun.status === "running");
  const stream = () =>
    !props.taskRun || running() ? core()?.streaming : undefined;
  effect(() => {
    if (!running() || !online()) return;
    now.set(Date.now());
    const timer = setInterval(() => now.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });

  const rows = computed(() => {
    const messages = transcript()?.messages ?? [];
    if (props.taskRun) {
      const from = props.taskRun.startedAt ?? props.taskRun.createdAt;
      const until = props.nextRunAt ?? Infinity;
      return messages.filter((entry) => entry.at >= from && entry.at < until);
    }
    const start = props.reply && runFromOf(props.reply.data);
    if (start !== undefined)
      return messages.filter((message) => message.seq > start);
    const briefing = messages.findLastIndex(
      (entry) => entry.message.role === "user",
    );
    return messages.slice(Math.max(0, briefing));
  });
  const blocks = computed(() => logBlocks(rows(), stream()));
  const timing = computed(() =>
    transcriptTiming(rows(), stream(), running() ? now() : undefined),
  );
  const stamp = () =>
    rows()[0]?.at ?? props.taskRun?.startedAt ?? props.reply?.createdAt;
  const failure = () => {
    if (running() || blocks().some((block) => block.type === "error"))
      return undefined;
    if (props.taskRun) return props.taskRun.error ?? undefined;
    const from = rows()[0]?.seq;
    const failed = systems()?.rows.findLast(
      (entry) =>
        entry.kind === "run_failed" && from !== undefined && entry.seq >= from,
    );
    if (failed) return failed.args.error || uiText("runGenericFailure");
    return props.reply?.status === "failed"
      ? props.reply.text || uiText("runGenericFailure")
      : undefined;
  };
  const visible = computed(() =>
    blocks().filter(
      (block) => block.type !== "thinking" || expanded() || open()[block.id],
    ),
  );

  const details = () => [
    running() ? uiText("running") : "",
    thinking()
      ? uiText("runThinkingLevel", { level: thinking() })
      : uiText("defaultThinking"),
  ];

  function toggleAll() {
    const next = !expanded();
    expanded.set(next);
    open.set({});
    if (!next) selected.set("");
  }

  function select(ids: string[]) {
    const step = blocks().find((block) => ids.includes(block.id));
    if (!step) return;
    selected.set(step.id);
    open.update((items) => ({ ...items, [step.id]: true }));
    setTimeout(() => refs.get(step.id)?.reveal({ vertical: "nearest" }), 0);
  }

  function selectKind(blocks: Iterable<string>) {
    const ids = [...blocks];
    if (!ids.length) return;
    const current = ids.indexOf(selected());
    select([ids[(current + 1) % ids.length]!]);
  }

  const inset = props.phone ? 16 : 12;
  return (
    <View style={grow}>
      <View
        style={{
          paddingHorizontal: inset,
          paddingTop: props.phone ? 12 : 10,
          paddingBottom: props.phone ? 12 : 8,
          flexShrink: 0,
          gap: props.phone ? 8 : 6,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View style={{ ...row, height: props.phone ? 24 : 28, gap: 8 }}>
          <AgentFace id={props.agentId} size={18} />
          <Label
            size={props.phone ? 14 : 12}
            line={props.phone ? 18 : 16}
            weight={props.phone ? 400 : 500}
            lines={1}
          >
            {props.executorName ??
              host.agent(props.agentId)?.name ??
              uiText("agent")}
          </Label>
          <If when={props.phone}>
            <Label
              size={12}
              line={16}
              tone="muted"
              lines={1}
              style={{ flex: 1, minWidth: 0 }}
            >
              {props.meta ??
                [stamp() ? runDate(stamp()!) : "", ...details()]
                  .filter(Boolean)
                  .join(" · ")}
            </Label>
          </If>
          <If when={!props.phone}>
            <If when={!props.meta && stamp()}>
              <Label size={10} line={12} tone="muted" lines={1}>
                {runDate(stamp()!)}
              </Label>
            </If>
            <Label
              size={12}
              line={16}
              tone="muted"
              lines={1}
              style={{ flex: 1, minWidth: 0 }}
            >
              {props.meta ??
                (stamp() ? "· " : "") + details().filter(Boolean).join(" · ")}
            </Label>
            <View
              role="button"
              accessibilityLabel={uiText(
                expanded() ? "collapseDetails" : "expandDetails",
              )}
              onPress={toggleAll}
              focusVisibleStyle={{
                outlineWidth: 1,
                outlineColor: c().blue,
                outlineOffset: 1,
              }}
              style={{ ...row, gap: 4, flexShrink: 0, cursor: "pointer" }}
            >
              <Label size={10} line={12} tone="muted">
                {uiText(expanded() ? "collapseDetails" : "expandDetails")}
              </Label>
              <Icon name="down" size={12} tone="muted" />
            </View>
            <CloseButton
              size={24}
              iconSize={16}
              style={{ marginRight: -4 }}
              onPress={props.onClose}
            />
          </If>
          <If
            when={
              props.phone && blocks().some((block) => block.type === "thinking")
            }
          >
            <Button
              label={uiText(expanded() ? "collapseDetails" : "expandDetails")}
              icon="down"
              iconOnly
              tone="ghost"
              size={24}
              onPress={toggleAll}
            />
          </If>
        </View>
        <If when={timing()}>
          {(trail) => (
            <>
              <View style={{ height: 10, backgroundColor: c().selected }}>
                <Each of={trail().segments} key={(segment) => segment.id}>
                  {(segment) => (
                    <View
                      role="button"
                      accessibilityLabel={uiText(
                        runKinds[segment().kind].label,
                      )}
                      accessibilityState={{
                        selected: segment().blocks.includes(selected()),
                      }}
                      onPress={() => select(segment().blocks)}
                      focusVisibleStyle={{
                        outlineWidth: 1,
                        outlineColor: c().ink,
                      }}
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${segment().from}%`,
                        width: `${segment().to - segment().from}%`,
                        backgroundColor: runKinds[segment().kind].color,
                        opacity:
                          selected() && !segment().blocks.includes(selected())
                            ? 0.65
                            : 1,
                        cursor: "pointer",
                      }}
                    />
                  )}
                </Each>
              </View>
              <View
                style={{
                  ...row,
                  flexWrap: "wrap",
                  columnGap: 12,
                  rowGap: props.phone ? 4 : 1,
                }}
              >
                <Each
                  of={Object.keys(runKinds) as (keyof typeof runKinds)[]}
                  key={(kind) => kind}
                >
                  {(kind) => (
                    <If when={trail().totals.get(kind())}>
                      {(duration) => (
                        <View
                          role="button"
                          accessibilityLabel={uiText("showRunSteps", {
                            kind: uiText(runKinds[kind()].label),
                          })}
                          onPress={() =>
                            selectKind(trail().blocksByKind.get(kind()) ?? [])
                          }
                          focusVisibleStyle={{
                            outlineColor: c().ink,
                            outlineWidth: 1,
                          }}
                          style={{
                            ...row,
                            gap: 4,
                            minHeight: props.phone ? 14 : 18,
                            cursor: "pointer",
                          }}
                        >
                          <If
                            when={props.phone}
                            else={
                              <StatusDot
                                color={runKinds[kind()].color}
                                size={8}
                              />
                            }
                          >
                            <Label
                              size={11}
                              line={14}
                              style={{ color: runKinds[kind()].color }}
                            >
                              ■
                            </Label>
                          </If>
                          <Label
                            size={11}
                            line={props.phone ? 14 : 16}
                            tone="muted"
                          >
                            {uiText(runKinds[kind()].label)}
                          </Label>
                          <Label
                            size={11}
                            line={props.phone ? 14 : 16}
                            weight={500}
                          >
                            {runDuration(duration())}
                          </Label>
                        </View>
                      )}
                    </If>
                  )}
                </Each>
              </View>
            </>
          )}
        </If>
      </View>
      <If when={!online()}>
        <View
          style={{
            ...row,
            paddingHorizontal: inset,
            paddingVertical: 5,
            gap: 8,
            backgroundColor: c().selected,
          }}
        >
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {uiText("runReconnectStatus")}
          </Label>
          <Button
            label={uiText("retry")}
            tone="ghost"
            onPress={host.reconnect}
          />
        </View>
      </If>
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: inset }}>
          <Each of={visible()} key={(block) => block.id}>
            {(block, index) => (
              <View
                ref={(ref) => {
                  if (ref) refs.set(block().id, ref);
                  else refs.delete(block().id);
                }}
              >
                <TranscriptLine
                  session={props.session}
                  block={block()}
                  firstTool={
                    index() === 0 || visible()[index() - 1]?.type !== "tool"
                  }
                  afterTool={visible()[index() - 1]?.type === "tool"}
                  phone={props.phone}
                  opened={open()[block().id] ?? expanded()}
                  selected={selected() === block().id}
                  onToggle={() => {
                    const id = block().id;
                    open.update((items) => ({
                      ...items,
                      [id]: !(items[id] ?? expanded()),
                    }));
                  }}
                />
              </View>
            )}
          </Each>
          <If when={failure()}>
            {(reason) => (
              <Label size={12} tone="red" style={{ marginTop: 8 }}>
                {`${uiText("runFailed")} · ${reason()}`}
              </Label>
            )}
          </If>
          <If when={!visible().length && !failure()}>
            <Label tone="muted" size={12}>
              {host.state().missing[target]
                ? uiText("sessionUnavailable")
                : !transcript() && !online()
                  ? uiText("offlineRunTranscript")
                  : !transcript()
                    ? uiText("loadingRunTranscript")
                    : running()
                      ? uiText("waitingForAgent")
                      : uiText("noRunTranscript")}
            </Label>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
