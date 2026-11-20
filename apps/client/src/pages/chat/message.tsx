import type {
  ArtifactView,
  AttachmentView,
  CaptainOperationView,
  MemberView,
  MessageView,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import {
  captainProposalOf,
  publishedRefs,
  runBlocks,
  runFromOf,
  savedSteps,
} from "@eta/client-contracts";
import { effect, List, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
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
import { activeReply } from "./member-status";
import { messageTime } from "./message-time";
import { ProcessStep } from "./process-step";
import { Widget, widgetFrom } from "./widgets/widget";

export function Message(props: {
  item: MessageView;
  additions: MessageView[];
  canInsert: boolean;
  onInsert: () => void;
  phone: boolean;
  compact?: boolean;
  members: MemberView[];
  onArtifact: (artifact: ArtifactView, version: number) => void;
  onWidgetDraft: (text: string) => void;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const details = signal(false);
  const item = () => props.item;
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
  const card = () =>
    item().kind === "task_card" || item().kind === "task_draft";
  return (
    <View
      style={{
        alignSelf: "stretch",
        gap: item().author === "user" || card() ? 4 : 0,
        paddingVertical: props.phone || card() ? 0 : 16,
        paddingHorizontal: props.phone || props.compact || card() ? 0 : 16,
      }}
    >
      <If when={item().author === "user"}>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <View
            style={{
              maxWidth: props.phone ? "84%" : "72%",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
              paddingVertical: 8,
              paddingHorizontal: 12,
            }}
          >
            <Label line={props.phone ? 22 : 23}>{item().text}</Label>
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
                <Label line={props.phone ? 22 : 23}>
                  {`[${file().name} · ${(file().size / 1024).toFixed(1)} KB]`}
                </Label>
              )}
            </Each>
          </View>
          <Label
            size={10}
            line={14}
            tone="faint"
            style={{
              textTransform: props.phone ? "none" : "uppercase",
              letterSpacing: props.phone ? 0 : 0.4,
            }}
          >
            {stamp()}
          </Label>
          <If when={props.canInsert}>
            <Button
              label={uiText("insert")}
              tone="ghost"
              size={26}
              onPress={props.onInsert}
            />
          </If>
        </View>
      </If>
      <If when={item().kind === "task_card" || item().kind === "task_draft"}>
        <If when={task()}>
          {(value) => (
            <TaskSummary
              task={value()}
              subtasks={
                value().subtasks?.total
                  ? subtasksOf(host.tasks(), value())
                  : undefined
              }
              onPress={() => props.onTask(value().id)}
            />
          )}
        </If>
        <If when={item().kind === "task_draft"}>
          <View
            style={{
              padding: 10,
              borderWidth: 1,
              borderColor: c().border,
              gap: 6,
            }}
          >
            <Caption text={uiText("taskDraft")} />
            <Label>{String(item().data.title ?? item().text)}</Label>
            <Button
              label={uiText("confirmTask")}
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
        <If when={item().agentId}>
          <View style={{ ...row, gap: 8, marginBottom: 10 }}>
            <AgentFace id={item().agentId} size={14} />
            <Label size={12} weight={600}>
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
                  size={8}
                  tone="muted"
                />
                <Caption
                  text={uiText("thinkingProcess")}
                  style={{ letterSpacing: 0.8, color: c().faint }}
                />
                <View style={{ flex: 1 }} />
                <Caption
                  style={{ letterSpacing: 0.8, color: c().faint }}
                  text={uiText(
                    steps().length === 1
                      ? "oneProcessStep"
                      : "processStepCount",
                    {
                      count: steps().length,
                    },
                  )}
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
        <If
          when={review()}
          else={
            <If when={item().text}>
              <If
                when={item().status === "failed"}
                else={
                  <View style={{ paddingHorizontal: 2 }}>
                    <Markdown
                      value={item().text}
                      line={props.phone ? 22 : 24}
                    />
                  </View>
                }
              >
                <Label
                  line={props.phone ? 22 : 24}
                  tone="amber"
                  style={{ paddingHorizontal: 2 }}
                >
                  {item().text}
                </Label>
              </If>
            </If>
          }
        >
          {(items) => <CaptainReview items={items()} time={stamp()} />}
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
        <If when={!review()}>
          <Label
            size={10}
            line={14}
            tone="faint"
            style={{
              marginTop: 8,
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
