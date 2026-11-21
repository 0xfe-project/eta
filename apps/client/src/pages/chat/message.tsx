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
import {
  captainProposalOf,
  publishedRefs,
  runBlocks,
  runFromOf,
  savedSteps,
} from "@eta/client-contracts";
import { effect, List, signal, View } from "nsh";
import { Popover } from "nsh/base";
import {
  Button,
  Caption,
  colors,
  focusRing,
  Icon,
  Label,
  Markdown,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { clock, follow, useHost } from "../../services/host";
import { subtasksOf, TaskSummary } from "../tasks/status";
import { Proposal, Question } from "./approvals";
import { ArtifactRow } from "./artifacts/row";
import { CaptainReview, reviewItemsOf } from "./captain-review";
import { cardOpen, setCardOpen } from "./card-folds";
import { activeReply } from "./member-status";
import { messageTime } from "./message-time";
import { ProcessStep } from "./process-step";
import { draftTitle } from "./task-draft-detail";
import { Widget, widgetFrom } from "./widgets/widget";

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
  onTask: (id: string) => void;
  onPending?: () => void;
  onReadDraft: (item: MessageView) => void;
  registerAction: (id: string, focus: () => void) => () => void;
}) {
  const host = useHost();
  const c = colors();
  const details = signal(false);
  const item = () => props.item;
  let action: ViewRef | undefined;
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
    if (id !== previousId) details.set(false);
    previousId = id;
  });
  const active = () => activeReply(item().status);
  const session = () =>
    activeReply(item().status)
      ? props.members.find((member) => member.agentId === item().agentId)
          ?.sessionId
      : undefined;
  const target = () => (session() ? `sessions.${session()}` : undefined);
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
  const attached = () =>
    Array.isArray(item().data.attachments)
      ? (item().data.attachments as AttachmentView[])
      : [];
  const stamp = () => messageTime(item().createdAt, props.phone);
  const artifacts = () =>
    publishedRefs(steps()).flatMap((ref) => {
      const artifact = host
        .artifacts()
        .find((entry) => entry.id === ref.artifactId);
      return artifact ? [{ ref, artifact }] : [];
    });
  const widgets = () =>
    steps().flatMap((step) => {
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
        gap: item().author === "user" || card() ? 4 : props.phone ? 8 : 0,
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
            <Label line={props.phone ? 20 : 23}>{item().text}</Label>
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
                  <Label size={10} tone="muted">
                    {uiText("inserted", { clock: clock(addition().createdAt) })}
                  </Label>
                  <Label>{addition().text}</Label>
                </View>
              )}
            </Each>
            <Each of={attached()} key={(file) => file.id}>
              {(file) => (
                <Label line={props.phone ? 20 : 23}>
                  {`[${file().name} · ${(file().size / 1024).toFixed(1)} KB]`}
                </Label>
              )}
            </Each>
          </View>
          <View style={{ ...row, gap: 8 }}>
            <Label
              size={10}
              line={props.phone ? 12 : 14}
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
                      size={10}
                      line={12}
                      tone={props.inserting ? "ink" : "muted"}
                      style={{ letterSpacing: 1, textTransform: "uppercase" }}
                    >
                      {uiText("insert")}
                    </Label>
                  </View>
                }
              >
                {props.insertPanel?.()}
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
           * title, that it waits for you and the way to confirm it. */}
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
                size={10}
                line={14}
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
                size={12}
                line={16}
                weight={500}
                lines={1}
                style={{ flex: 1, minWidth: props.phone ? 200 : 0 }}
              >
                {draftTitle(item())}
              </Label>
              <View
                style={{
                  flexShrink: 0,
                  paddingHorizontal: 5,
                  borderWidth: 1,
                  borderColor: c().warning,
                }}
              >
                <Label size={10} line={14} tone="warningInk">
                  {uiText("draftNeedsConfirming")}
                </Label>
              </View>
              <Button
                label={uiText("readDraft")}
                size={22}
                labelSize={12}
                tone="ghost"
                controlRef={(node) => {
                  action = node;
                }}
                onPress={() => props.onReadDraft(item())}
              />
              <Button
                label={uiText("confirmTask")}
                size={22}
                labelSize={12}
                onPress={() =>
                  void host.action(() =>
                    host.call("tasks", "confirmDraft", {
                      conversationId: item().conversationId,
                      messageId: item().id,
                    }),
                  )
                }
              />
            </View>
            <If when={cardIsOpen() && draftDescription()}>
              <View
                style={{
                  padding: 10,
                  borderTopWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Markdown value={draftDescription()} line={20} />
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
              marginBottom: props.phone ? 0 : 10,
            }}
          >
            <AgentFace
              id={item().agentId}
              size={props.phone ? (active() ? 18 : 16) : 14}
            />
            <Label size={12} line={16} weight={600}>
              {host.agent(item().agentId)?.name ??
                (item().author === "captain" ? "Captain" : uiText("agent"))}
            </Label>
          </View>
        </If>
        <If
          when={active()}
          else={
            <If when={steps().length}>
              <View
                role="button"
                accessibilityLabel={uiText("thinkingProcess")}
                accessibilityState={{ expanded: details() }}
                onPress={() => details.set(!details())}
                hoverStyle={{ backgroundColor: c().selected }}
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
                  name={details() ? "down" : "right"}
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
                    steps().length === 1
                      ? "oneProcessStep"
                      : "processStepCount",
                    {
                      count: steps().length,
                    },
                  )}`}
                />
              </View>
              <If when={details()}>
                <View
                  style={{
                    borderWidth: 1,
                    borderTopWidth: 0,
                    borderColor: c().border,
                  }}
                >
                  <Each of={steps()} key={(step) => step.id}>
                    {(step) => <ProcessStep value={step()} />}
                  </Each>
                </View>
              </If>
            </If>
          }
        >
          <View style={{ borderWidth: 1, borderColor: c().border }}>
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
              <Label size={10} line={12} tone="muted">
                {steps().length
                  ? uiText("processSteps", { length: steps().length })
                  : item().status === "queued"
                    ? uiText("queued")
                    : item().status === "stopping"
                      ? uiText("stopping")
                      : uiText("working")}
              </Label>
              <Button
                label={uiText("stop")}
                size={18}
                labelSize={10}
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
            <If
              when={!details() && steps().length > 5}
              else={
                <Each of={steps()} key={(step) => step.id}>
                  {(step) => <ProcessStep value={step()} />}
                </Each>
              }
            >
              {/* A fixed window on the newest steps; older ones scroll up. */}
              <List
                style={{ height: 176, flexShrink: 0 }}
                each={steps()}
                keyExtractor={(step) => step.id}
                initialScrollAtEnd
                estimatedItemSize={33}
                maintainVisibleContentPosition={{
                  autoscrollToBottomThreshold: 40,
                }}
              >
                {(step) => <ProcessStep value={step()} />}
              </List>
            </If>
          </View>
          <If when={steps().length > 5}>
            <View
              style={{ alignItems: "flex-end", paddingRight: 8, marginTop: 8 }}
            >
              <View
                role="button"
                accessibilityLabel={
                  details() ? uiText("viewLess") : uiText("viewMore")
                }
                onPress={() => details.set(!details())}
                style={{ cursor: "pointer" }}
              >
                <Label size={11} line={14} tone="muted">
                  {details() ? uiText("viewLess") : uiText("viewMore")}
                </Label>
              </View>
            </View>
          </If>
        </If>
        <If when={item().status === "failed" && !review()}>
          {/* A failed reply is its time, then why, as a warning line. */}
          <View style={{ gap: 8 }}>
            <Label
              size={10}
              line={12}
              tone="muted"
              style={{ letterSpacing: 1, textTransform: "uppercase" }}
            >
              {messageTime(item().createdAt, false)}
            </Label>
            <Label size={14} line={18} tone="warning">
              {`⚠ ${failure()}`}
            </Label>
          </View>
        </If>
        <If
          when={review()}
          else={
            <If when={item().text}>
              <If when={item().status !== "failed"}>
                <View style={{ paddingHorizontal: 2 }}>
                  <Markdown value={item().text} line={props.phone ? 22 : 24} />
                </View>
              </If>
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
            size={10}
            line={props.phone ? 12 : 14}
            tone={props.phone ? "muted" : "faint"}
            style={{
              marginTop: props.phone ? 0 : 8,
              letterSpacing: props.phone ? 0 : 0.4,
              textTransform: props.phone ? "none" : "uppercase",
            }}
          >
            {stamp()}
          </Label>
        </If>
      </If>
    </View>
  );
}
