import type {
  LogBlock,
  MessageView,
  SessionViewSections,
  TaskRunView,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { logBlocks, savedSteps, savedTools } from "@eta/client-contracts";
import { cleanup, computed, effect, signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import { CloseButton } from "../../../components/navigation-buttons";
import { StatusDot } from "../../../components/status-dot";
import { formatLocale, uiText } from "../../../i18n";
import { clock, followSession, useHost } from "../../../services/host";
import { activeReply } from "../member-status";
import {
  replyRun,
  runDuration,
  runKinds,
  transcriptTiming,
} from "./run-timing";
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

/**
 * What a finished reply kept on its row, as a log: its process, then its answer. What a reply is
 * read from when its session no longer holds its run (a member that left, an old run, a page
 * opened afresh before the session came).
 */
function savedLog(reply: MessageView): LogBlock[] {
  const steps = savedSteps(reply).filter(
    (block): block is Exclude<typeof block, { type: "steer" }> =>
      block.type !== "steer",
  );
  return reply.status !== "failed" && reply.text
    ? [...steps, { type: "text", id: "answer", text: reply.text }]
    : steps;
}

/** A finished run's length, "13m 47s"; a running one's clock, "1:04:17". */
function runLength(ms: number, clockFace: boolean) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (clockFace)
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/**
 * One run read whole: its header (who, when, how it went), its timing strip and every step, then
 * what it said. A task run's log, a member's latest run, or a reply's process: `taskRun` bounds it
 * by the run's times, `reply` by where the reply's run sits in the session, and a finished reply
 * the session no longer holds is read from what its row kept.
 */
export function MemberRun(props: {
  /** The member's session; a finished reply can be read without one. */
  session?: string | null;
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
  const target = props.session ? `sessions.${props.session}` : "";
  followSession(() => props.session ?? undefined);
  const transcript = () =>
    host.section<TranscriptSection>(target, "transcript");
  const core = () => host.section<ViewCore>(target, "core");
  const systems = () =>
    host.section<SessionViewSections["systems"]>(target, "systems");
  const modelSection = () =>
    host.section<SessionViewSections["model"]>(target, "model");
  /**
   * The session's level as it runs: the one asked for, or, where the model does not take it, the
   * model's default with the asked one named. A host too old to say what was asked shows what runs.
   */
  const thinkingText = () => {
    const section = modelSection();
    if (section === undefined) return uiText("defaultThinking");
    const asked =
      section.thinkingAsked === undefined
        ? section.thinkingLevel === "off"
          ? null
          : section.thinkingLevel
        : section.thinkingAsked;
    if (asked === null) return uiText("defaultThinking");
    return asked === section.thinkingLevel
      ? uiText("runThinkingLevel", { level: asked })
      : uiText("runThinkingFellBack", { level: asked });
  };
  const online = () => host.state().status === "open";
  /** The reply is still being written. */
  const replyLive = () =>
    props.reply !== undefined && activeReply(props.reply.status);
  const running = () =>
    core()?.running === true &&
    (props.taskRun
      ? props.taskRun.status === "running"
      : !props.reply || replyLive());
  const stream = () =>
    running() || (!props.taskRun && !props.reply)
      ? core()?.streaming
      : undefined;
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
    if (props.reply)
      return (
        replyRun(
          messages,
          props.reply,
          replyLive(),
          savedTools(props.reply.data)[0]?.id,
        ) ?? []
      );
    const briefing = messages.findLastIndex(
      (entry) => entry.message.role === "user",
    );
    return messages.slice(Math.max(0, briefing));
  });
  const blocks = computed(() =>
    props.reply && !replyLive() && !rows().length
      ? savedLog(props.reply)
      : logBlocks(rows(), stream()),
  );
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

  /** A task run's state: a small mark, its word, and how long it took. */
  const runState = () => {
    const run = props.taskRun;
    if (!run) return undefined;
    const start = run.startedAt ?? run.createdAt;
    const active =
      run.status === "running" ||
      run.status === "starting" ||
      run.status === "queued";
    const color =
      run.status === "failed"
        ? c().red
        : run.status === "completed"
          ? c().green
          : active
            ? c().blue
            : c().muted;
    const word = uiText(
      run.status === "completed"
        ? "done"
        : run.status === "interrupted"
          ? "runStatusStopped"
          : run.status,
    );
    if (run.status === "running")
      return {
        color,
        word: `${word} ${runLength(now() - start, true)}`,
        took: "",
      };
    return {
      color,
      word,
      took:
        run.finishedAt && run.startedAt
          ? uiText("runTook", {
              duration: runLength(run.finishedAt - run.startedAt, false),
            })
          : "",
    };
  };
  const details = () => [running() ? uiText("running") : "", thinkingText()];

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
          <Label variant="small" weight={props.phone ? 400 : 500} lines={1}>
            {props.executorName ??
              host.agent(props.agentId)?.name ??
              uiText("agent")}
          </Label>
          <If when={runState()}>
            {(state) => (
              <View style={{ ...row, flex: 1, minWidth: 0, gap: 8 }}>
                <StatusDot color={state().color} />
                <Label variant="small" lines={1}>
                  {state().word}
                </Label>
                <If when={state().took}>
                  <Label
                    variant="small"
                    tone="muted"
                    lines={1}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {`· ${state().took}`}
                  </Label>
                </If>
              </View>
            )}
          </If>
          <If when={props.phone && !runState()}>
            <Label
              variant="small"
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
            <If when={!runState() && !props.meta && stamp()}>
              <Label variant="caption" tone="muted" lines={1}>
                {runDate(stamp()!)}
              </Label>
            </If>
            <If when={!runState()}>
              <Label
                variant="small"
                tone="muted"
                lines={1}
                style={{ flex: 1, minWidth: 0 }}
              >
                {props.meta ??
                  (stamp() ? "· " : "") + details().filter(Boolean).join(" · ")}
              </Label>
            </If>
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
              <Label variant="caption" tone="muted">
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
                              variant="caption"
                              style={{ color: runKinds[kind()].color }}
                            >
                              ■
                            </Label>
                          </If>
                          <Label variant="caption" tone="muted">
                            {uiText(runKinds[kind()].label)}
                          </Label>
                          <Label variant="caption" weight={500}>
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
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {uiText("runReconnectStatus")}
          </Label>
          <Button
            label={uiText("retry")}
            tone="ghost"
            onPress={host.reconnect}
          />
        </View>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
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
                  session={props.session ?? ""}
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
          {/* A task run says it failed in its header; the reason is the
              body's last line, in plain ink. */}
          <If when={!props.taskRun && failure()}>
            {(reason) => (
              <Label variant="small" tone="red" style={{ marginTop: 8 }}>
                {`${uiText("runFailed")} · ${reason()}`}
              </Label>
            )}
          </If>
          <If
            when={
              props.taskRun && !visible().length && transcript() && online()
            }
          >
            <Label tone="muted" variant="small">
              {uiText("noRunRecords")}
            </Label>
          </If>
          <If when={props.taskRun ? failure() : undefined}>
            {(reason) => (
              <Label
                variant="small"
                tone="mutedInk"
                style={{ marginTop: visible().length ? 8 : 4 }}
              >
                {reason()}
              </Label>
            )}
          </If>
          <If
            when={
              !visible().length &&
              !failure() &&
              !(props.taskRun && transcript() && online())
            }
          >
            <Label tone="muted" variant="small">
              {!target
                ? uiText("noRunTranscript")
                : host.state().missing[target]
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
      </SmoothScroll>
    </View>
  );
}
