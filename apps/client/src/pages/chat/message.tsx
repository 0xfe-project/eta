import type {
  ArtifactView,
  AttachmentView,
  CaptainOperationView,
  MemberView,
  MessageView,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { JSX, ViewRef } from "nsh";
import type { TextSelection } from "../../components/eta-editor";
import type { DeliveryActions } from "./composer-delivery";
import {
  captainProposalOf,
  isPictureType,
  publishedRefs,
  runBlocks,
  runFromOf,
  savedSteps,
} from "@eta/client-contracts";
import { pasteBlocksOf } from "@eta/client-contracts/composer-draft";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import {
  cleanup,
  Clipboard,
  createMotion,
  effect,
  reduceMotion,
  signal,
  View,
} from "nsh";
import {
  Button,
  Caption,
  colors,
  Compact,
  focusRing,
  Icon,
  Label,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { EmptyState } from "../../components/empty-state";
import {
  chatText,
  chipMaxWidth,
  LineRoom,
  shownFiles,
  shownMentions,
} from "../../components/eta-editor";
import { showToast } from "../../components/toast";
import {
  avatar,
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { uiText } from "../../i18n";
import { clock, follow, useHost } from "../../services/host";
import { PictureModes } from "../../services/picture-mode";
import { problemReason } from "../../services/problem-text";
import { Popover } from "../../ui";
import { subtasksOf, TaskSummary } from "../tasks/status";
import { Proposal, Question } from "./approvals";
import { ArtifactRow } from "./artifacts/row";
import { CaptainReview, reviewItemsOf } from "./captain-review";
import { cardOpen, setCardOpen } from "./card-folds";
import { DeliveryLine } from "./composer-delivery";
import { activeReply } from "./member-status";
import { messageTime } from "./message-time";
import { ProcessStep, ProcessWindow } from "./process-step";
import { MemberRun } from "./run/member-run";
import { RunPanel } from "./run/run-panel";
import { draftTitle } from "./task-draft-detail";
import { Widget, widgetFrom } from "./widgets/widget";

/** Every block of a reply (process, text, widget, artifact, question, time)
 * sits this far from the next, on every screen size. */
const replyBlockGap = 8;

/** A reply at work keeps this height, however much it writes. */
const processWindowHeight = 176;
/** Streaming caret blink period. */
const CARET_BLINK_MS = 900;

/** 2px accent caret shown at the end of a streaming AI answer (steady under reduced motion). */
function StreamingCaret() {
  const c = colors();
  const blink = createMotion();
  effect(() => {
    if (reduceMotion()) {
      blink.stop();
      blink.reset();
      return;
    }
    void blink.play({
      keyframes: { opacity: [1, 0.2, 1] },
      duration: CARET_BLINK_MS,
      easing: "easeInOut",
      iterations: "infinite",
    });
  });
  cleanup(() => blink.stop());
  return (
    <View
      testID="streaming-caret"
      style={{
        width: space[2],
        height: space[16],
        backgroundColor: c().blue,
        marginTop: space[2],
        ...(reduceMotion() ? {} : blink.style),
      }}
    />
  );
}

/** How wide your message's bubble runs, and on phones the least room a task draft's title keeps. A
 * draft's card has no width of its own: like a task's card it fills the column, whose width is
 * the appearance setting's. */
const bubbleShare = { phone: 0.84, desktop: 0.72 } as const;
const bubbleWidth = {
  phone: `${bubbleShare.phone * 100}%`,
  desktop: `${bubbleShare.desktop * 100}%`,
} as const;
const draftTitleWidth = 200;

/** How each code the host fails a reply with is said. */
const failureReasons: Record<string, Parameters<typeof uiText>[0]> = {
  restart: "replyRestart",
  run_failed: "runGenericFailure",
  unavailable: "replyUnavailable",
  gone: "replyGone",
};

export function Message(props: {
  item: MessageView;
  additions: MessageView[];
  canInsert: boolean;
  onInsert: () => void;
  /** The insert popover under this user message is open. */
  inserting?: boolean;
  onInsertClose?: () => void;
  /** What the insert popover holds while it is open. */
  insertPanel?: () => JSX.Element;
  /** The next reply of the same member failed the same way: say so, not why. */
  sameFailureAsNext?: boolean;
  /**
   * A message of the reader's still on its way (the host has not taken it): faded while it goes,
   * red with why and what to do once it failed. Its row becomes the host's when that comes.
   */
  delivery?: { failure?: string } & DeliveryActions;
  phone: boolean;
  compact?: boolean;
  captain?: boolean;
  members: MemberView[];
  onArtifact: (artifact: ArtifactView, version: number) => void;
  onWidgetDraft: (text: string) => void;
  /** The reader selected part of the reply's text (`""`: nothing); `reply` is
   * the view around that text. */
  onSelectionChange?: (
    event: TextSelection,
    reply: ViewRef | undefined,
  ) => void;
  /** A mention's press: the member it names, by agent id. */
  onMember?: (agentId: string) => void;
  onTask: (id: string) => void;
  onPending?: () => void;
  /** Re-send the prompt that triggered a completed or failed reply. */
  onRetry?: () => void;
  onReadDraft: (item: MessageView) => void;
  registerAction: (id: string, focus: () => void) => () => void;
}) {
  const host = useHost();
  const c = colors();
  /** The reply's whole run is open in the run panel. */
  const process = signal(false);
  /** The live process window above the streaming answer can be collapsed by the reader. */
  const processCollapsed = signal(false);
  /** Downward-only minimum height reservation while the answer streams so height never jumps up. */
  const minAnswerHeight = signal(0);
  const item = () => props.item;
  let action: ViewRef | undefined;
  let reply: ViewRef | undefined;
  effect(() => {
    const message = item();
    if (message.kind === "task_draft" || message.kind === "task_card")
      return props.registerAction(message.id, () => action?.focus());
  });
  const review = () => {
    const items = reviewItemsOf(item());
    return items.length ? items : undefined;
  };
  let previousId: string | undefined;
  effect(() => {
    const id = item().id;
    if (id !== previousId) {
      process.set(false);
      processCollapsed.set(false);
      minAnswerHeight.set(0);
    }
    previousId = id;
  });
  const active = () => activeReply(item().status);
  const session = () =>
    activeReply(item().status)
      ? props.members.find((member) => member.agentId === item().agentId)
          ?.sessionId
      : undefined;
  const target = () => (session() ? `sessions.${session()}` : undefined);
  /** The member's session, at work or not: the run panel reads the reply's run from it. */
  const memberSession = () =>
    props.members.find((member) => member.agentId === item().agentId)
      ?.sessionId;
  follow(target);
  const steps = () => {
    const id = target();
    if (!id) return savedSteps(item());
    return runBlocks(
      host.section<TranscriptSection>(id, "transcript")?.messages ?? [],
      host.section<ViewCore>(id, "core")?.streaming,
      runFromOf(item().data),
    );
  };
  /** While streaming, the trailing assistant text block renders directly in the answer area. */
  const streamingBlock = () => {
    if (!active()) return undefined;
    const last = steps().at(-1);
    return last?.type === "text" && last.text ? last : undefined;
  };
  const processSteps = () =>
    streamingBlock() ? steps().slice(0, -1) : steps();
  /** The steps a count says: a trace of an insert is not one. */
  const stepCount = () =>
    processSteps().filter((step) => step.type !== "steer").length;
  /** The answer text: streams live as it arrives, or shows the final saved reply text. */
  const answer = () => {
    if (item().status === "failed") return undefined;
    if (active()) return streamingBlock()?.text;
    return item().text || undefined;
  };
  const attached = () =>
    Array.isArray(item().data.attachments)
      ? (item().data.attachments as AttachmentView[])
      : [];
  /** The members as a message's text names them (`@label`), for its mentions. */
  const mentionRefs = () => {
    const named = props.members.map((member) => ({
      id: member.agentId,
      name: host.agent(member.agentId)?.name ?? member.agentId,
    }));
    return named.map((member) => ({
      id: member.id,
      label: mentionLabel(member, named),
    }));
  };
  /** A sent message's text as kept: its folded pastes and mentions with it. */
  const stored = (message: MessageView) => ({
    text: message.text,
    blocks: pasteBlocksOf(message.data, message.text),
    mentions: mentionRefs(),
  });
  // A mention opens its member; a file saves, a picture opens.
  const shown = [shownMentions(props.onMember), shownFiles()];
  const stamp = () => messageTime(item().createdAt, props.phone);
  const artifacts = () =>
    publishedRefs(active() ? [] : steps()).flatMap((ref) => {
      const artifact = host
        .artifacts()
        .find((entry) => entry.id === ref.artifactId);
      return artifact ? [{ ref, artifact }] : [];
    });
  /** Artifacts the reply published that the host's list no longer has: deleted. */
  const goneArtifacts = () =>
    host.state().targets.artifacts
      ? publishedRefs(active() ? [] : steps()).filter(
          (ref) =>
            !host.artifacts().some((entry) => entry.id === ref.artifactId),
        )
      : [];
  // While it works, everything is in the window and nothing outside it.
  const widgets = () =>
    (active() ? [] : steps()).flatMap((step) => {
      const widget = widgetFrom(step);
      return widget ? [widget] : [];
    });
  const question = () =>
    host.pending().find((entry) => entry.replyId === item().id);
  const operation = () => {
    const proposal = captainProposalOf(item());
    return proposal
      ? host
          .list<CaptainOperationView>("captain", "operations")
          .find((op) => op.id === proposal.operationId)
      : undefined;
  };
  const task = () =>
    [
      ...host.tasks(),
      ...host.list<import("@eta/client-contracts").BoardTaskView>(
        "tasks",
        "archived",
      ),
    ].find((entry) => entry.id === item().data.taskId);
  const draftDescription = () =>
    typeof item().data.description === "string"
      ? (item().data.description as string)
      : "";
  const failure = () => {
    if (props.sameFailureAsNext) return uiText("replySameFailure");
    const code = String(item().data.code ?? "");
    const reason = failureReasons[code] ?? "replyFailed";
    // The host's own words say why; after a restart they only repeat it.
    const detail =
      code === "restart" || !item().text ? "" : problemReason(item().text);
    return detail ? `${uiText(reason)} ${detail}` : uiText(reason);
  };
  const discarded = () => item().data.discarded === true;
  const busy = signal(false);
  const rowWidth = signal(0);
  const share = () => (props.phone ? bubbleShare.phone : bubbleShare.desktop);
  const bubbleBorderAndPadding = 2 * (1 + space[12]);
  const measured = () => rowWidth() > 0;
  const lineRoom = () =>
    measured() ? Math.max(0, rowWidth() * share() - bubbleBorderAndPadding) : 0;
  const pictureModes = PictureModes();
  /** A chip is laid in the text's line and adds nothing to the bubble's own width, so a
   * bubble that holds one is never narrower than the chip's longest. */
  const holdsChip = () => {
    const compact = pictureModes.mode() !== "expanded";
    const chipIn = (message: MessageView) =>
      !!pasteBlocksOf(message.data, message.text) ||
      (compact && message.text.includes("!["));
    return (
      attached().some((file) => compact || !isPictureType(file.contentType)) ||
      chipIn(item()) ||
      props.additions.some((addition) => chipIn(addition))
    );
  };
  /** Stop was pressed and the host has not said the reply is stopping yet. */
  const stopping = signal(false);
  async function discard() {
    if (busy()) return;
    busy.set(true);
    await host.action(() =>
      host.call("tasks", "discardDraft", {
        conversationId: item().conversationId,
        messageId: item().id,
      }),
    );
    busy.set(false);
  }
  const card = () =>
    item().kind === "task_card" || item().kind === "task_draft";
  // A draft is one folded line from the moment it exists; a card, which is here because the reader
  // confirmed it, is open. Either way the reader's own choice stands, through a reload.
  const cardIsOpen = () => cardOpen(item().id, item().kind === "task_card");
  const toggleCard = () => setCardOpen(item().id, !cardIsOpen());
  return (
    <View
      style={{
        alignSelf: "stretch",
        gap: item().author === "user" || card() ? space[4] : replyBlockGap,
        // A review card and a failed reply are one block each, 24 apart.
        paddingVertical: card()
          ? 0
          : review() || item().status === "failed"
            ? space[8]
            : props.phone
              ? 0
              : space[16],
        paddingHorizontal:
          props.phone || props.compact || card() ? 0 : space[16],
      }}
    >
      <If when={item().author === "user"}>
        <View
          // The row is as wide as the message, whatever the bubble holds: the line's room is
          // the bubble's share of it, less the bubble's border and padding (the bubble itself
          // fits its content, so it cannot be measured for this).
          onLayout={({ bounds }) => rowWidth.set(bounds.size.width)}
          style={{ alignItems: "flex-end", gap: space[4] }}
        >
          <View
            accessibilityLabel={
              props.delivery
                ? uiText(
                    props.delivery.failure ? "sendFailedLabel" : "sendingLabel",
                    { text: item().text },
                  )
                : undefined
            }
            style={{
              maxWidth: props.phone ? bubbleWidth.phone : bubbleWidth.desktop,
              minWidth:
                measured() && holdsChip()
                  ? Math.min(
                      chipMaxWidth + space[2] + bubbleBorderAndPadding,
                      rowWidth() * share(),
                    )
                  : undefined,
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: props.delivery?.failure
                ? c().redFill
                : props.phone
                  ? c().selected
                  : c().surface,
              opacity:
                props.delivery && !props.delivery.failure ? opacity.muted : 1,
              paddingVertical: space[8],
              paddingHorizontal: space[12],
            }}
          >
            <LineRoom.Provider value={lineRoom}>
              <chatText.View
                text={{ ...stored(item()), files: attached() }}
                plugins={shown}
                label={uiText("yourMessage")}
              />
              <Each of={props.additions} key={(addition) => addition.id}>
                {(addition) => (
                  <View
                    style={{
                      gap: space[2],
                      marginTop: space[8],
                      paddingTop: space[8],
                      borderTopWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label variant="caption" tone="muted">
                      {uiText("inserted", {
                        clock: clock(addition().createdAt),
                      })}
                    </Label>
                    <chatText.View
                      text={stored(addition())}
                      plugins={shown}
                      label={uiText("insertedMessage")}
                    />
                  </View>
                )}
              </Each>
            </LineRoom.Provider>
          </View>
          <If when={props.delivery}>
            {(delivery) => (
              <DeliveryLine
                failure={delivery().failure}
                phone={props.phone}
                onRetry={delivery().onRetry}
                onEdit={delivery().onEdit}
                onDiscard={delivery().onDiscard}
              />
            )}
          </If>
          <If when={!props.delivery}>
            <View style={{ ...row, gap: space[8] }}>
              <Label
                variant="caption"
                tone={props.phone ? "muted" : "faint"}
                tracking={props.phone ? undefined : "caps"}
                style={{
                  textTransform: props.phone ? "none" : "uppercase",
                }}
              >
                {stamp()}
              </Label>
              <If when={props.canInsert || props.inserting}>
                <Popover
                  open={props.inserting ?? false}
                  placement="bottom"
                  align="end"
                  offset={6}
                  margin={8}
                  onOpenChange={(open) => {
                    if (open) props.onInsert();
                    else props.onInsertClose?.();
                  }}
                  trigger={
                    <View
                      role="button"
                      accessibilityLabel={uiText("insertMessage")}
                      hoverStyle={{ borderColor: c().ink }}
                      focusVisibleStyle={focusRing(c())}
                      style={{
                        paddingVertical: 1,
                        paddingHorizontal: space[8],
                        borderWidth: 1,
                        borderColor: props.inserting ? c().ink : c().border,
                        cursor: "pointer",
                      }}
                    >
                      <Label
                        tracking="caps"
                        variant="caption"
                        tone={props.inserting ? "ink" : "muted"}
                        style={{ textTransform: "uppercase" }}
                      >
                        {uiText("insert")}
                      </Label>
                    </View>
                  }
                >
                  <Compact>{props.insertPanel?.()}</Compact>
                </Popover>
              </If>
            </View>
          </If>
        </View>
      </If>
      <If when={item().kind === "task_card" || item().kind === "task_draft"}>
        <If
          when={
            item().kind === "task_card" &&
            !task() &&
            !!host.state().targets.tasks
          }
        >
          <EmptyState
            size="row"
            status="empty"
            loading={null}
            error={null}
            empty={{ title: uiText("taskGone") }}
            style={{
              paddingHorizontal: space[12],
              borderWidth: 1,
              borderColor: c().border,
            }}
          />
        </If>
        <If when={task()}>
          {(value) => (
            <TaskSummary
              controlRef={(node) => {
                action = node;
              }}
              task={value()}
              open={cardIsOpen()}
              onToggle={toggleCard}
              subtasks={
                value().subtasks?.total
                  ? subtasksOf(host.tasks(), value())
                  : undefined
              }
              phone={props.phone}
              onPress={() => props.onTask(value().id)}
            />
          )}
        </If>
        <If when={item().kind === "task_draft"}>
          {/* Folded to one line, as a turn's process is: what it is, its
           * title, that it waits for you and the way to the form. */}
          <View
            style={{
              alignSelf: "stretch",
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              role={draftDescription() ? "button" : undefined}
              accessibilityLabel={uiText("taskDraft")}
              accessibilityState={
                draftDescription() ? { expanded: cardIsOpen() } : undefined
              }
              onPress={draftDescription() ? toggleCard : undefined}
              hoverStyle={
                draftDescription()
                  ? { backgroundColor: c().selected }
                  : undefined
              }
              focusVisibleStyle={focusRing(c())}
              style={{
                ...row,
                flexWrap: props.phone ? "wrap" : "nowrap",
                columnGap: space[8],
                rowGap: space[4],
                paddingVertical: space[8],
                paddingHorizontal: space[12],
                cursor: draftDescription() ? "pointer" : undefined,
              }}
            >
              <If when={draftDescription()}>
                <Icon
                  name={cardIsOpen() ? "down" : "right"}
                  size={icon.sm}
                  tone="faint"
                />
              </If>
              <Label
                tracking="caps"
                variant="caption"
                tone="faint"
                style={{
                  flexShrink: 0,
                  textTransform: "uppercase",
                }}
              >
                {uiText("taskDraft")}
              </Label>
              <Label
                variant="small"
                weight={weight.regular}
                lines={1}
                style={{ flex: 1, minWidth: props.phone ? draftTitleWidth : 0 }}
              >
                {draftTitle(item())}
              </Label>
              <If
                when={!discarded()}
                else={
                  <View
                    style={{
                      flexShrink: 0,
                      paddingHorizontal: space[4],
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label variant="caption" tone="faint">
                      {uiText("draftDiscarded")}
                    </Label>
                  </View>
                }
              >
                <View
                  style={{
                    flexShrink: 0,
                    paddingHorizontal: space[4],
                    borderWidth: 1,
                    borderColor: c().warning,
                  }}
                >
                  <Label variant="caption" tone="warningInk">
                    {uiText("draftNeedsConfirming")}
                  </Label>
                </View>
                {/* The draft's actions, as in the design and apps/web: one
                 * opens the form, and only the form's own confirm creates the
                 * task; the other discards the draft, as the proposals' does. */}
                <Button
                  label={uiText("editAndConfirm")}
                  size={control.sm}
                  controlRef={(node) => {
                    action = node;
                  }}
                  onPress={() => props.onReadDraft(item())}
                />
                <Button
                  label={uiText("discard")}
                  size={control.sm}
                  disabled={host.state().status !== "open"}
                  busy={busy()}
                  onPress={() => void discard()}
                />
              </If>
            </View>
            <If when={cardIsOpen() && draftDescription()}>
              <View
                style={{
                  padding: space[12],
                  borderTopWidth: 1,
                  borderColor: c().border,
                }}
              >
                <chatText.View
                  text={{ text: draftDescription(), mentions: mentionRefs() }}
                  plugins={shown}
                  label={uiText("taskDraft")}
                />
              </View>
            </If>
          </View>
        </If>
      </If>
      <If when={operation()}>{(op) => <Proposal operation={op()} />}</If>
      <If
        when={
          item().author !== "user" &&
          item().kind !== "task_card" &&
          item().kind !== "task_draft" &&
          !operation()
        }
      >
        <If when={!props.captain && item().agentId}>
          <View
            style={{
              ...row,
              gap: props.phone && !active() ? space[4] : space[8],
              // The name sits 10 from the first block on wider screens.
              marginBottom: props.phone ? 0 : 10 - replyBlockGap,
            }}
          >
            <AgentFace
              id={item().agentId}
              size={props.phone ? avatar.sm : avatar.sm}
            />
            <Label variant="small" weight={weight.strong}>
              {host.agent(item().agentId)?.name ??
                (item().author === "captain" ? "Captain" : uiText("agent"))}
            </Label>
          </View>
        </If>
        <If
          when={active()}
          else={
            <If when={stepCount()}>
              <View
                role="button"
                accessibilityLabel={uiText("thinkingProcess")}
                onPress={() => process.set(true)}
                hoverStyle={{ backgroundColor: c().selected }}
                focusVisibleStyle={focusRing(c())}
                style={{
                  ...row,
                  height: control.md,
                  gap: space[8],
                  paddingHorizontal: space[12],
                  borderWidth: 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name="right"
                  size={icon.sm}
                  tone={props.phone ? "faint" : "muted"}
                />
                <Caption
                  text={uiText("thinkingProcess")}
                  style={{ color: c().faint }}
                />
                <View style={{ flex: 1 }} />
                <Caption
                  style={{ color: c().faint }}
                  text={`${props.phone ? "· " : ""}${uiText(
                    stepCount() === 1 ? "oneProcessStep" : "processStepCount",
                    { count: stepCount() },
                  )}`}
                />
              </View>
            </If>
          }
        >
          {/* Collapsible live steps window above the streaming answer, preserving per-member Stop. */}
          <View
            testID="process-window"
            style={{ borderWidth: 1, borderColor: c().border }}
          >
            <View
              style={{
                ...row,
                height: space[24],
                paddingLeft: space[12],
                paddingRight: space[4],
                justifyContent: "space-between",
                borderBottomWidth:
                  processSteps().length > 0 && !processCollapsed() ? 1 : 0,
                borderColor: c().border,
              }}
            >
              <View
                role={processSteps().length > 0 ? "button" : undefined}
                accessibilityLabel={uiText("thinkingProcess")}
                accessibilityState={
                  processSteps().length > 0
                    ? { expanded: !processCollapsed() }
                    : undefined
                }
                onPress={
                  processSteps().length > 0
                    ? () => processCollapsed.set(!processCollapsed())
                    : undefined
                }
                style={{
                  ...row,
                  gap: space[4],
                  flex: 1,
                  minWidth: 0,
                  cursor: processSteps().length > 0 ? "pointer" : "default",
                }}
              >
                <If when={processSteps().length > 0}>
                  <Icon
                    name={processCollapsed() ? "right" : "down"}
                    size={icon.sm}
                    tone="muted"
                  />
                </If>
                <Label variant="caption" tone="muted" lines={1}>
                  {stepCount()
                    ? stepCount() === 1
                      ? uiText("processOneStep")
                      : uiText("processSteps", { length: stepCount() })
                    : item().status === "queued"
                      ? uiText("queued")
                      : item().status === "stopping"
                        ? uiText("stopping")
                        : uiText("working")}
                </Label>
              </View>
              <Button
                label={uiText("stop")}
                size={control.sm}
                labelVariant="caption"
                labelWeight={weight.strong}
                style={{ paddingHorizontal: space[8] }}
                disabled={item().status === "stopping"}
                busy={stopping() && item().status !== "stopping"}
                onPress={() => {
                  stopping.set(true);
                  void host
                    .action(() =>
                      host.call("conversations", "stop", {
                        conversationId: item().conversationId,
                        messageId: item().id,
                      }),
                    )
                    .then((result) => {
                      if (result === undefined) stopping.set(false);
                    });
                }}
              />
            </View>
            <If when={processSteps().length > 0 && !processCollapsed()}>
              <ProcessWindow height={processWindowHeight}>
                <Each of={processSteps()} key={(step) => step.id}>
                  {(step) => <ProcessStep value={step()} />}
                </Each>
              </ProcessWindow>
            </If>
          </View>
          {/* The whole run, in the panel a task run is read in. Before the
           * first step there is nothing more to see: kept, so the first step
           * moves nothing. */}
          <View
            style={{
              ...row,
              justifyContent: "flex-end",
              paddingRight: space[8],
              opacity: stepCount() ? 1 : 0,
            }}
          >
            <View
              role="button"
              accessibilityLabel={uiText("processViewMore")}
              onPress={stepCount() ? () => process.set(true) : undefined}
              hoverStyle={{ opacity: opacity.muted }}
              focusVisibleStyle={focusRing(c())}
              style={{ cursor: stepCount() ? "pointer" : undefined }}
            >
              <Label variant="caption" tone="muted">
                {uiText("processViewMore")}
              </Label>
            </View>
          </View>
        </If>
        <If when={item().status === "failed" && !review()}>
          {/* A failed reply is its time, then why, as a warning line, plus Retry when available. */}
          <View style={{ gap: space[8] }}>
            <Label
              tracking="caps"
              variant="caption"
              tone="muted"
              style={{ textTransform: "uppercase" }}
            >
              {messageTime(item().createdAt, false)}
            </Label>
            <Label tone="warning">{`⚠ ${failure()}`}</Label>
            <If when={props.onRetry}>
              <View style={row}>
                <Button
                  label={uiText("retry")}
                  icon="refresh"
                  size={control.sm}
                  iconSize={icon.sm}
                  labelVariant="caption"
                  style={{ gap: space[4], paddingHorizontal: space[8] }}
                  onPress={() => props.onRetry?.()}
                />
              </View>
            </If>
          </View>
        </If>
        <If
          when={review()}
          else={
            <If when={answer()}>
              {(text) => (
                <View
                  testID="reply-answer"
                  ref={(node) => {
                    reply = node;
                  }}
                  onLayout={(event) => {
                    if (
                      active() &&
                      event.bounds.size.height > minAnswerHeight()
                    )
                      minAnswerHeight.set(event.bounds.size.height);
                  }}
                  style={{
                    paddingHorizontal: space[2],
                    minHeight:
                      active() && minAnswerHeight() > 0
                        ? minAnswerHeight()
                        : undefined,
                  }}
                >
                  <chatText.View
                    text={{ text: text(), mentions: mentionRefs() }}
                    plugins={shown}
                    streaming={active()}
                    label={uiText("replyOf", {
                      name: host.agent(item().agentId)?.name ?? uiText("agent"),
                    })}
                    onSelectionChange={(event) =>
                      props.onSelectionChange?.(event, reply)
                    }
                  />
                  <If when={active()}>
                    <StreamingCaret />
                  </If>
                </View>
              )}
            </If>
          }
        >
          {(items) => (
            <CaptainReview
              items={items()}
              time={messageTime(item().createdAt, false)}
              onPending={props.onPending}
            />
          )}
        </If>
        <If when={item().status === "stopped"}>
          <Label variant="small" tone="muted">
            {uiText("replyStopped")}
          </Label>
        </If>
        <Each of={widgets()} key={(widget) => widget.id}>
          {(widget) => (
            <Widget value={widget()} onDraft={props.onWidgetDraft} />
          )}
        </Each>
        <Each of={artifacts()} key={(entry) => entry.ref.id}>
          {(entry) => (
            <ArtifactRow
              artifact={entry().artifact}
              version={entry().ref.version}
              onPress={() =>
                props.onArtifact(entry().artifact, entry().ref.version)
              }
            />
          )}
        </Each>
        <Each of={goneArtifacts()} key={(ref) => ref.id}>
          {() => (
            <EmptyState
              size="row"
              status="empty"
              loading={null}
              error={null}
              empty={{ title: uiText("artifactDeleted") }}
              style={{ paddingHorizontal: 0 }}
            />
          )}
        </Each>
        <If when={question()}>{(entry) => <Question item={entry()} />}</If>
        <If when={!review() && item().status !== "failed"}>
          <View style={{ ...row, gap: space[8] }}>
            <Label
              variant="caption"
              tone={props.phone ? "muted" : "faint"}
              tracking={props.phone ? undefined : "caps"}
              style={{
                textTransform: props.phone ? "none" : "uppercase",
              }}
            >
              {stamp()}
            </Label>
            <If when={!active() && answer()}>
              <Button
                label={uiText("copy")}
                icon="copy"
                tone="ghost"
                size={control.sm}
                iconSize={icon.sm}
                labelVariant="caption"
                labelTone="muted"
                style={{ gap: space[4], paddingHorizontal: space[4] }}
                onPress={() =>
                  void host.action(async () => {
                    const value = answer();
                    if (!value) return;
                    await Clipboard.writeText(value);
                    showToast({ title: uiText("copied") });
                  })
                }
              />
            </If>
            <If when={!active() && props.onRetry}>
              <Button
                label={uiText("retry")}
                icon="refresh"
                tone="ghost"
                size={control.sm}
                iconSize={icon.sm}
                labelVariant="caption"
                labelTone="muted"
                style={{ gap: space[4], paddingHorizontal: space[4] }}
                onPress={() => props.onRetry?.()}
              />
            </If>
          </View>
        </If>
      </If>
      <If when={process()}>
        <RunPanel
          title={uiText("processOf", {
            name: host.agent(item().agentId)?.name ?? uiText("agent"),
          })}
          phone={props.phone}
          onClose={() => process.set(false)}
        >
          <MemberRun
            session={memberSession()}
            agentId={item().agentId ?? ""}
            phone={props.phone}
            reply={item()}
            onClose={() => process.set(false)}
          />
        </RunPanel>
      </If>
    </View>
  );
}
