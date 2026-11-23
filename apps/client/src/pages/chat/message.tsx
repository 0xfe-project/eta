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
import {
  captainProposalOf,
  publishedRefs,
  runBlocks,
  runFromOf,
  savedSteps,
} from "@eta/client-contracts";
import { pasteBlocksOf } from "@eta/client-contracts/composer-draft";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { effect, signal, View } from "nsh";
import { Popover } from "nsh/base";
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
import {
  chatText,
  shownFiles,
  shownMentions,
} from "../../components/eta-editor";
import { uiText } from "../../i18n";
import { clock, follow, useHost } from "../../services/host";
import { subtasksOf, TaskSummary } from "../tasks/status";
import { Proposal, Question } from "./approvals";
import { ArtifactRow } from "./artifacts/row";
import { CaptainReview, reviewItemsOf } from "./captain-review";
import { cardOpen, setCardOpen } from "./card-folds";
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
  onReadDraft: (item: MessageView) => void;
  registerAction: (id: string, focus: () => void) => () => void;
}) {
  const host = useHost();
  const c = colors();
  /** The reply's whole run is open in the run panel. */
  const process = signal(false);
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
    if (id !== previousId) process.set(false);
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
  /** The steps a count says: a trace of an insert is not one. */
  const stepCount = () =>
    steps().filter((step) => step.type !== "steer").length;
  /** The text after the last thought or call, once the run is over (`savedSteps`
   * keeps the process without it); a failed reply says why instead. */
  const answer = () =>
    active() || item().status === "failed" || !item().text
      ? undefined
      : item().text;
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
    const detail = code === "restart" || !item().text ? "" : ` ${item().text}`;
    return `${uiText(reason)}${detail}`;
  };
  const discarded = () => item().data.discarded === true;
  const busy = signal(false);
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
        gap: item().author === "user" || card() ? 4 : replyBlockGap,
        // A review card and a failed reply are one block each, 24 apart.
        paddingVertical: card()
          ? 0
          : review() || item().status === "failed"
            ? 6
            : props.phone
              ? 0
              : 16,
        paddingHorizontal: props.phone || props.compact || card() ? 0 : 16,
      }}
    >
      <If when={item().author === "user"}>
        <View style={{ alignItems: "flex-end", gap: props.phone ? 4 : 6 }}>
          <View
            style={{
              maxWidth: props.phone ? "84%" : "72%",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: props.phone ? c().selected : c().surface,
              paddingVertical: 8,
              paddingHorizontal: 12,
            }}
          >
            <chatText.View
              text={{ ...stored(item()), files: attached() }}
              plugins={shown}
              label={uiText("yourMessage")}
            />
            <Each of={props.additions} key={(addition) => addition.id}>
              {(addition) => (
                <View
                  style={{
                    gap: 3,
                    marginTop: 6,
                    paddingTop: 6,
                    borderTopWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label variant="caption" tone="muted">
                    {uiText("inserted", { clock: clock(addition().createdAt) })}
                  </Label>
                  <chatText.View
                    text={stored(addition())}
                    plugins={shown}
                    label={uiText("insertedMessage")}
                  />
                </View>
              )}
            </Each>
          </View>
          <View style={{ ...row, gap: 8 }}>
            <Label
              variant="caption"
              tone={props.phone ? "muted" : "faint"}
              style={{
                textTransform: props.phone ? "none" : "uppercase",
                letterSpacing: props.phone ? 0 : 0.4,
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
                onOpenChange={(event) => {
                  if (event.open) props.onInsert();
                  else props.onInsertClose?.();
                }}
                popupStyle={{
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                  boxShadow: [{ x: 0, y: 4, blur: 16, color: "#0a0a0a14" }],
                }}
                trigger={
                  <View
                    accessibilityLabel={uiText("insertMessage")}
                    hoverStyle={{ borderColor: c().ink }}
                    style={{
                      paddingVertical: 1,
                      paddingHorizontal: 6,
                      borderWidth: 1,
                      borderColor: props.inserting ? c().ink : c().border,
                      cursor: "pointer",
                    }}
                  >
                    <Label
                      variant="caption"
                      tone={props.inserting ? "ink" : "muted"}
                      style={{ letterSpacing: 1, textTransform: "uppercase" }}
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
        </View>
      </If>
      <If when={item().kind === "task_card" || item().kind === "task_draft"}>
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
              maxWidth: props.phone ? undefined : 560,
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
                columnGap: 8,
                rowGap: 6,
                paddingVertical: 6,
                paddingHorizontal: 10,
                cursor: draftDescription() ? "pointer" : undefined,
              }}
            >
              <If when={draftDescription()}>
                <Icon
                  name={cardIsOpen() ? "down" : "right"}
                  size={10}
                  tone="faint"
                />
              </If>
              <Label
                variant="caption"
                tone="faint"
                style={{
                  flexShrink: 0,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                }}
              >
                {uiText("taskDraft")}
              </Label>
              <Label
                variant="small"
                weight={500}
                lines={1}
                style={{ flex: 1, minWidth: props.phone ? 200 : 0 }}
              >
                {draftTitle(item())}
              </Label>
              <If
                when={!discarded()}
                else={
                  <View
                    style={{
                      flexShrink: 0,
                      paddingHorizontal: 5,
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
                    paddingHorizontal: 5,
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
                  size={22}
                  controlRef={(node) => {
                    action = node;
                  }}
                  onPress={() => props.onReadDraft(item())}
                />
                <Button
                  label={uiText("discard")}
                  size={22}
                  disabled={busy() || host.state().status !== "open"}
                  onPress={() => void discard()}
                />
              </If>
            </View>
            <If when={cardIsOpen() && draftDescription()}>
              <View
                style={{
                  padding: 10,
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
              gap: props.phone && !active() ? 6 : 8,
              // The name sits 10 from the first block on wider screens.
              marginBottom: props.phone ? 0 : 10 - replyBlockGap,
            }}
          >
            <AgentFace
              id={item().agentId}
              size={props.phone ? (active() ? 18 : 16) : 14}
            />
            <Label variant="small" weight={600}>
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
                  height: 26,
                  gap: 8,
                  paddingHorizontal: 10,
                  borderWidth: 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name="right"
                  size={props.phone ? 10 : 8}
                  tone={props.phone ? "faint" : "muted"}
                />
                <Caption
                  text={uiText("thinkingProcess")}
                  style={{ letterSpacing: 0.8, color: c().faint }}
                />
                <View style={{ flex: 1 }} />
                <Caption
                  style={{ letterSpacing: 0.8, color: c().faint }}
                  text={`${props.phone ? "· " : ""}${uiText(
                    stepCount() === 1 ? "oneProcessStep" : "processStepCount",
                    { count: stepCount() },
                  )}`}
                />
              </View>
            </If>
          }
        >
          {/* A reply at work is one window of a fixed height: everything it
           * thought, said and did, in order, scrolling inside itself and
           * following the newest step unless the reader scrolled up. Nothing
           * is drawn outside it, so replies written at once never push each
           * other; the answer comes out when the run is over. */}
          <View
            testID="process-window"
            style={{ borderWidth: 1, borderColor: c().border }}
          >
            <View
              style={{
                ...row,
                height: 24,
                paddingLeft: 10,
                paddingRight: 4,
                justifyContent: "space-between",
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="caption" tone="muted">
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
              <Button
                label={uiText("stop")}
                size={18}
                labelVariant="caption"
                labelWeight={600}
                style={{ paddingHorizontal: 7 }}
                disabled={item().status === "stopping"}
                onPress={() =>
                  void host.action(() =>
                    host.call("conversations", "stop", {
                      conversationId: item().conversationId,
                      messageId: item().id,
                    }),
                  )
                }
              />
            </View>
            <ProcessWindow height={processWindowHeight}>
              <Each of={steps()} key={(step) => step.id}>
                {(step) => <ProcessStep value={step()} />}
              </Each>
            </ProcessWindow>
          </View>
          {/* The whole run, in the panel a task run is read in. Before the
           * first step there is nothing more to see: kept, so the first step
           * moves nothing. */}
          <View
            style={{
              ...row,
              justifyContent: "flex-end",
              paddingRight: 8,
              opacity: stepCount() ? 1 : 0,
            }}
          >
            <View
              role="button"
              accessibilityLabel={uiText("processViewMore")}
              onPress={stepCount() ? () => process.set(true) : undefined}
              hoverStyle={{ opacity: 0.7 }}
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
          {/* A failed reply is its time, then why, as a warning line. */}
          <View style={{ gap: 8 }}>
            <Label
              variant="caption"
              tone="muted"
              style={{ letterSpacing: 1, textTransform: "uppercase" }}
            >
              {messageTime(item().createdAt, false)}
            </Label>
            <Label tone="warning">{`⚠ ${failure()}`}</Label>
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
                  style={{ paddingHorizontal: 2 }}
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
        <If when={question()}>{(entry) => <Question item={entry()} />}</If>
        <If when={!review() && item().status !== "failed"}>
          <Label
            variant="caption"
            tone={props.phone ? "muted" : "faint"}
            style={{
              letterSpacing: props.phone ? 0 : 0.4,
              textTransform: props.phone ? "none" : "uppercase",
            }}
          >
            {stamp()}
          </Label>
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
