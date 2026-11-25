import type {
  BoardTaskStatus,
  CaptainOperationView,
  InteractionView,
  RoutineSummary,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout, TextVariant } from "../../components";
import { signal, View } from "nsh";
import {
  Caption,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  RowChevron,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { EmptyState } from "../../components/empty-state";
import { ListSkeleton } from "../../components/loading-skeleton";
import { CloseButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { CaptainFace } from "../../navigation/captain";
import { follow, relativeTime, useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { TaskGlyph, taskNeedsAttention } from "../tasks/status";
import { Proposal, Question } from "./approvals";
import { SectionHeading } from "./section-heading";

/** The dialog a question is answered in, wherever the question was opened from. */
/** The question dialog, and Captain's proposal as a phone sheet. */
const questionDialogHeight = 476;
const proposalSheetHeight = 620;

/** What waits for you: a phone's row and section heading, a row elsewhere, its action's column. */
const phoneRowHeight = 56;
const phoneSectionHeight = 32;
const rowHeight = 52;
const actionWidth = 56;

export function QuestionDialog(props: {
  item: InteractionView;
  phone: boolean;
  onClose: () => void;
  onConversation?: () => void;
  onSource?: () => void;
}) {
  const host = useHost();
  const name = () => host.agent(props.item.agentId)?.name ?? "Agent";
  return (
    <Modal
      title={uiText("questionFromWithCount", { value1: name() })}
      height={questionDialogHeight}
      phone={props.phone}
      sheet={props.phone}
      hideHeader
      overPhoneNavigation
      onClose={props.onClose}
    >
      <View
        style={{
          ...row,
          height: control.touch,
          paddingLeft: space[16],
          paddingRight: space[8],
          gap: space[8],
          flexShrink: 0,
        }}
      >
        <AgentFace id={props.item.agentId} size={avatar.md} />
        <Label weight={weight.strong} style={{ flex: 1 }}>
          {uiText("questionFromWithCount", { value1: name() })}
        </Label>
        <CloseButton
          size={control.lg}
          iconSize={icon.md}
          onPress={props.onClose}
        />
      </View>
      <Question
        item={props.item}
        sheet
        onDone={props.onClose}
        onConversation={props.onConversation}
        onSource={props.onSource}
      />
    </Modal>
  );
}

export function Pending(props: {
  conversationId?: string;
  layout: Layout;
  onTask?: (id: string) => void;
  onRoutines?: (id?: string) => void;
  onConversation?: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const chosenId = signal("");
  const chosen = () => host.pending().find((entry) => entry.id === chosenId());
  const proposalId = signal("");
  const phone = () => props.layout === "phone";
  follow(() => "routines");
  const load = useLoadState({ targets: () => ["inbox", "tasks"] });
  /** Nothing waits for the user: or not yet known, or it did not load. */
  function Nothing(nothing: { width?: "narrow" | "wide" }) {
    return (
      <EmptyState
        size="page"
        width={nothing.width}
        status={load.shown()}
        loading={<ListSkeleton label={uiText("loadingPending")} />}
        error={{
          title: uiText("pendingDidNotLoad"),
          description: load.why(),
          retry: load.retry,
          retrying: load.retrying(),
        }}
        empty={{
          art: "done",
          title: uiText("nothingIsWaitingForYou"),
          description: uiText("nothingIsWaitingForYouDescription"),
        }}
      />
    );
  }
  const items = () =>
    host
      .pending()
      .filter(
        (entry) =>
          !props.conversationId ||
          entry.conversationId === props.conversationId,
      );
  const operations = () =>
    host.list<CaptainOperationView>("captain", "operations");
  const proposals = () =>
    operations().filter(
      (op) =>
        op.requiresApproval &&
        op.status === "pending" &&
        (!props.conversationId ||
          op.payload.originConversationId === props.conversationId),
    );
  const proposal = () => operations().find((op) => op.id === proposalId());
  const reviews = () =>
    host
      .tasks()
      .filter(
        (item) =>
          taskNeedsAttention(item) &&
          (!props.conversationId ||
            item.conversationId === props.conversationId),
      );
  const routines = () => host.list<RoutineSummary>("routines");
  const reports = () =>
    routines().filter((item) => item.unseenReports || item.unseenFailures);
  function PendingRow(props: {
    title: string;
    detail: string;
    agent?: string | null;
    task?: BoardTaskStatus;
    routines?: boolean;
    strong?: boolean;
    when?: number;
    attention?: boolean;
    first?: boolean;
    onPress: () => void;
  }) {
    return (
      <View
        role="button"
        accessibilityLabel={props.title}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          minHeight: phoneRowHeight,
          paddingLeft: space[16],
          paddingRight: space[12],
          gap: space[12],
          borderTopWidth: props.first ? 1 : 0,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <View
          style={{ width: control.md, alignItems: "center", flexShrink: 0 }}
        >
          <If when={props.agent}>
            <AgentFace id={props.agent} size={avatar.md} />
          </If>
          <If when={props.task}>
            <TaskGlyph status={props.task!} size={icon.md} />
          </If>
          <If when={props.routines}>
            <Icon name="routines" size={icon.lg} />
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <Label
            weight={props.strong ? weight.strong : weight.regular}
            lines={1}
          >
            {props.title}
          </Label>
          <Label variant="caption" tone="muted" lines={1}>
            {props.detail}
          </Label>
        </View>
        <If when={props.attention}>
          <StatusDot color={props.routines ? c().red : c().blue} />
        </If>
        <If when={props.when}>
          <Label
            variant="caption"
            tone="muted"
            style={{ width: control.md, textAlign: "right", flexShrink: 0 }}
          >
            {relativeTime(props.when!)}
          </Label>
        </If>
        <RowChevron />
      </View>
    );
  }
  /** A phone section's 30pt caption: the label, then its count. */
  function PhoneSection(props: {
    label: string;
    count: number;
    gap?: boolean;
  }) {
    return (
      <View
        style={{
          ...row,
          height: phoneSectionHeight,
          gap: space[4],
          paddingHorizontal: space[16],
          marginTop: props.gap ? space[8] : 0,
          flexShrink: 0,
        }}
      >
        <Caption text={props.label} />
        <Label variant="caption" tone="muted">
          {props.count}
        </Label>
      </View>
    );
  }
  function PanelRow(props: {
    title: string;
    detail: string;
    detailTone?: "warning" | "ink" | "muted";
    detailVariant?: TextVariant;
    action: string;
    actionLink?: boolean;
    actionTone?: "ink" | "muted";
    children?: JSX.Element;
    onPress: () => void;
  }) {
    return (
      <View
        role="button"
        accessibilityLabel={props.title}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          height: rowHeight,
          gap: space[8],
          paddingHorizontal: space[12],
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <View
          style={{
            ...row,
            justifyContent: "center",
            width: space[16],
            height: space[16],
            flexShrink: 0,
          }}
        >
          {props.children}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <Label variant="small" lines={1}>
            {props.title}
          </Label>
          <Label
            variant={props.detailVariant ?? "caption"}
            tone={props.detailTone ?? "muted"}
            lines={1}
          >
            {props.detail}
          </Label>
        </View>
        <Label
          variant="caption"
          tone={props.actionTone ?? "ink"}
          style={{
            width: actionWidth,
            flexShrink: 0,
            textAlign: "right",
            textDecorationLine: props.actionLink ? "underline" : "none",
          }}
        >
          {props.action}
        </Label>
        <Icon name="right" size={icon.sm} tone="muted" />
      </View>
    );
  }
  function PanelPending() {
    const asks = () => items().length + proposals().length;
    return (
      <If
        when={asks() + reviews().length + reports().length}
        else={<Nothing width="narrow" />}
      >
        <SmoothScroll style={grow} scrollbar={false}>
          <If when={asks()}>
            <SectionHeading
              label={uiText("waitingForYouCaption")}
              count={asks()}
            />
            <Each of={items()} key={(entry) => entry.id}>
              {(entry) => (
                <AskRow
                  caption={uiText("confirmationRequestFrom", {
                    name: host.agent(entry().agentId)?.name ?? uiText("agent"),
                  })}
                  text={entry().prompt}
                  onPress={() => chosenId.set(entry().id)}
                />
              )}
            </Each>
            <Each of={proposals()} key={(op) => op.id}>
              {(op) => (
                <AskRow
                  caption={uiText("proposalFromCaptain")}
                  text={String(
                    op().payload.title ??
                      op().payload.name ??
                      op().kind.replaceAll("_", " "),
                  )}
                  onPress={() => proposalId.set(op().id)}
                />
              )}
            </Each>
          </If>
          <If when={reviews().length}>
            <SectionHeading
              label={uiText("tasksToCheckCaption")}
              count={reviews().length}
            />
            <Each of={reviews()} key={(item) => item.id}>
              {(item) => (
                <PanelRow
                  title={`#${item().number} ${item().title}`}
                  detail={
                    item().status === "blocked"
                      ? uiText("prerequisiteCancelledShort")
                      : uiText("taskInReview")
                  }
                  detailTone={item().status === "blocked" ? "ink" : "warning"}
                  detailVariant={
                    item().status === "blocked" ? "caption" : "small"
                  }
                  action={
                    item().status === "blocked"
                      ? uiText("decideAction")
                      : uiText("reviewAction")
                  }
                  actionLink
                  onPress={() => props.onTask?.(item().id)}
                >
                  <TaskGlyph status={item().status} size={icon.md} />
                </PanelRow>
              )}
            </Each>
          </If>
          <If when={props.onRoutines && reports().length}>
            <SectionHeading
              label={uiText("routines2")}
              count={reports().length}
            />
            <Each of={reports()} key={(routine) => routine.id}>
              {(routine) => (
                <PanelRow
                  title={routine().name}
                  detail={
                    routine().unseenFailures
                      ? uiText("failureCount", {
                          count: routine().unseenFailures,
                        })
                      : uiText("newReport", {
                          unseenReports: routine().unseenReports,
                        })
                  }
                  detailTone={routine().unseenFailures ? "ink" : "muted"}
                  action={
                    routine().unseenFailures
                      ? uiText("failed")
                      : uiText("newBadge")
                  }
                  actionTone={routine().unseenFailures ? "ink" : "muted"}
                  onPress={() => props.onRoutines?.(routine().id)}
                >
                  <Icon
                    name="routines"
                    size={icon.md}
                    tone={routine().unseenFailures ? "red" : "muted"}
                  />
                </PanelRow>
              )}
            </Each>
          </If>
        </SmoothScroll>
      </If>
    );
  }
  function AskRow(props: {
    caption: string;
    text: string;
    onPress: () => void;
  }) {
    return (
      <View
        role="button"
        accessibilityLabel={props.text}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          gap: space[2],
          paddingVertical: space[12],
          paddingHorizontal: space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <Label
          tracking="caps"
          variant="caption"
          tone="warning"
          lines={1}
          style={{ textTransform: "uppercase" }}
        >
          {props.caption}
        </Label>
        <Label variant="small">{props.text}</Label>
      </View>
    );
  }
  return (
    <View
      style={{
        ...grow,
        // Standalone page keeps the canvas; inside the conversation panel it inherits the panel surface.
        ...(props.conversationId ? {} : { backgroundColor: c().canvas }),
      }}
    >
      <If when={!props.conversationId}>
        <Header title={uiText("pending")} layout={props.layout}>
          <Label variant="caption" tone="muted">
            {uiText("waitingForYou", {
              value1: items().length + proposals().length + reviews().length,
            })}
          </Label>
        </Header>
      </If>
      <If when={props.conversationId}>
        <PanelPending />
      </If>
      <If
        when={!props.conversationId && phone()}
        else={
          <If when={!props.conversationId}>
            <If
              when={
                items().length +
                  proposals().length +
                  reviews().length +
                  (props.onRoutines ? reports().length : 0) >
                0
              }
              else={<Nothing />}
            >
              <SmoothScroll style={grow}>
                <View style={{ gap: space[8], padding: space[12] }}>
                  <Each of={items()} key={(entry) => entry.id}>
                    {(entry) => <Question item={entry()} />}
                  </Each>
                  <Each of={proposals()} key={(op) => op.id}>
                    {(op) => <Proposal operation={op()} />}
                  </Each>
                  <If when={reviews().length}>
                    <Caption
                      text={uiText("tasksToCheck", {
                        length: reviews().length,
                      })}
                    />
                    <Each of={reviews()} key={(item) => item.id}>
                      {(item) => (
                        <PendingRow
                          title={`#${item().number} ${item().title}`}
                          detail={
                            item().status === "blocked"
                              ? uiText("prerequisiteCancelledDecide")
                              : uiText("inReviewReview")
                          }
                          task={item().status}
                          onPress={() => props.onTask?.(item().id)}
                        />
                      )}
                    </Each>
                  </If>
                  <If when={props.onRoutines && reports().length}>
                    <Caption
                      text={uiText("routines", { length: reports().length })}
                    />
                    <Each of={reports()} key={(routine) => routine.id}>
                      {(routine) => (
                        <PendingRow
                          title={routine().name}
                          detail={
                            routine().unseenFailures
                              ? uiText("failedWithCount", {
                                  unseenFailures: routine().unseenFailures,
                                })
                              : uiText("newReport", {
                                  unseenReports: routine().unseenReports,
                                })
                          }
                          routines
                          attention={routine().unseenFailures > 0}
                          onPress={() => props.onRoutines?.(routine().id)}
                        />
                      )}
                    </Each>
                  </If>
                </View>
              </SmoothScroll>
            </If>
          </If>
        }
      >
        <SmoothScroll style={grow} scrollbar={false}>
          <If when={items().length + proposals().length}>
            <PhoneSection
              label={uiText("confirmationRequestCaption")}
              count={items().length + proposals().length}
            />
          </If>
          <Each of={items()} key={(entry) => entry.id}>
            {(entry, index) => (
              <PendingRow
                title={entry().prompt}
                detail={uiText("questionFrom", {
                  value1: host.agent(entry().agentId)?.name ?? "Agent",
                  value2: entry().conversationId
                    ? ` · ${
                        host.conversation(entry().conversationId)?.name ??
                        "Conversation"
                      }`
                    : "",
                })}
                agent={entry().agentId}
                attention
                first={index() === 0}
                when={entry().createdAt}
                onPress={() => chosenId.set(entry().id)}
              />
            )}
          </Each>
          <Each of={proposals()} key={(item) => item.id}>
            {(item, index) => (
              <PendingRow
                title={String(
                  item().payload.title ??
                    item().payload.name ??
                    item().kind.replaceAll("_", " "),
                )}
                detail={uiText("proposalFromCaptain")}
                agent={host.captain()?.id}
                attention
                first={index() === 0 && !items().length}
                when={item().createdAt}
                onPress={() => proposalId.set(item().id)}
              />
            )}
          </Each>
          <If when={reviews().length}>
            <PhoneSection
              label={uiText("tasks2")}
              count={reviews().length}
              gap={items().length + proposals().length > 0}
            />
          </If>
          <Each of={reviews()} key={(item) => item.id}>
            {(item, index) => (
              <PendingRow
                title={`#${item().number} ${item().title}`}
                detail={`${item().status === "blocked" ? "Needs your decision" : "For you to check"}${
                  item().conversationId
                    ? ` · ${
                        host.conversation(item().conversationId)?.name ??
                        "Conversation"
                      }`
                    : ""
                }`}
                task={item().status}
                attention
                first={index() === 0}
                when={item().updatedAt}
                onPress={() => props.onTask?.(item().id)}
              />
            )}
          </Each>
          <PendingRow
            title={uiText("routines2")}
            routines
            strong
            detail={uiText("routinesNewReportsFailures", {
              length: routines().length,
              reduce: routines().reduce(
                (sum, item) => sum + item.unseenReports,
                0,
              ),
              value3: routines().reduce(
                (sum, item) => sum + item.unseenFailures,
                0,
              ),
            })}
            attention={routines().some((item) => item.unseenFailures > 0)}
            first={!reviews().length}
            onPress={() => props.onRoutines?.()}
          />
          <If
            when={!items().length && !proposals().length && !reviews().length}
          >
            <Nothing />
          </If>
        </SmoothScroll>
      </If>
      <If when={chosen()}>
        {(entry) => (
          <QuestionDialog
            item={entry()}
            phone={phone()}
            onClose={() => chosenId.set("")}
            onConversation={
              entry().conversationId && props.onConversation
                ? () => props.onConversation!(entry().conversationId!)
                : undefined
            }
          />
        )}
      </If>
      <If when={proposal()}>
        {(entry) => (
          <Modal
            title={uiText("proposalFromCaptain")}
            height={phone() ? proposalSheetHeight : undefined}
            phone={phone()}
            sheet={phone()}
            hideHeader
            overPhoneNavigation
            onClose={() => proposalId.set("")}
          >
            <View
              style={{
                ...row,
                height: control.touch,
                paddingLeft: space[16],
                paddingRight: space[8],
                gap: space[8],
                flexShrink: 0,
              }}
            >
              <CaptainFace size={avatar.md} />
              <Label weight={weight.strong} style={{ flex: 1 }}>
                {uiText("proposalFromCaptain")}
              </Label>
              <CloseButton
                size={control.lg}
                iconSize={icon.md}
                onPress={() => proposalId.set("")}
              />
            </View>
            <Proposal
              operation={entry()}
              sheet
              onConversation={
                typeof entry().payload.originConversationId === "string" &&
                props.onConversation
                  ? () =>
                      props.onConversation!(
                        entry().payload.originConversationId as string,
                      )
                  : undefined
              }
            />
          </Modal>
        )}
      </If>
    </View>
  );
}
