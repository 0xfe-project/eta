import type {
  CaptainOperationView,
  RoutineSummary,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  Caption,
  colors,
  Empty,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CloseButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { follow, relativeTime, useHost } from "../../services/host";
import { TaskGlyph, taskNeedsAttention } from "../tasks/status";
import { Proposal, Question } from "./approvals";

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
    icon?: "tasks" | "routines";
    when?: number;
    attention?: boolean;
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
          minHeight: 55,
          paddingHorizontal: 16,
          gap: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <View style={{ width: 30, alignItems: "center", flexShrink: 0 }}>
          <If
            when={props.agent}
            else={
              <Icon
                name={props.icon ?? "bell"}
                size={17}
                tone={props.icon === "tasks" ? "amber" : "ink"}
              />
            }
          >
            <AgentFace id={props.agent} size={24} />
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label lines={1}>{props.title}</Label>
          <Label size={11} line={16} tone="muted" lines={1}>
            {props.detail}
          </Label>
        </View>
        <If when={props.attention}>
          <StatusDot color={props.icon === "routines" ? c().red : c().blue} />
        </If>
        <If when={props.when}>
          <Label size={10} tone="muted">
            {relativeTime(props.when!)}
          </Label>
        </If>
        <Icon name="right" size={9} tone="muted" />
      </View>
    );
  }
  function SectionHeader(props: { label: string; count: number }) {
    return (
      <View
        style={{
          ...row,
          height: 28,
          gap: 8,
          paddingHorizontal: 12,
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Caption text={props.label} />
        <Label size={10} line={14} tone="muted">
          {props.count}
        </Label>
      </View>
    );
  }
  function PanelRow(props: {
    title: string;
    detail: string;
    detailTone?: "amber" | "ink" | "muted";
    detailSize?: number;
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
          height: 52,
          gap: 10,
          paddingHorizontal: 12,
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
            width: 16,
            height: 16,
            flexShrink: 0,
          }}
        >
          {props.children}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label size={13} line={17} lines={1}>
            {props.title}
          </Label>
          <Label
            size={props.detailSize ?? 11}
            line={props.detailSize === 12 ? 20 : 14}
            tone={props.detailTone ?? "muted"}
            lines={1}
          >
            {props.detail}
          </Label>
        </View>
        <Label
          size={props.actionLink ? 11 : 10}
          line={14}
          tone={props.actionTone ?? "ink"}
          style={{
            width: 56,
            flexShrink: 0,
            textAlign: "right",
            textDecorationLine: props.actionLink ? "underline" : "none",
          }}
        >
          {props.action}
        </Label>
        <Icon name="right" size={10} tone="muted" />
      </View>
    );
  }
  function PanelPending() {
    const asks = () => items().length + proposals().length;
    return (
      <If
        when={asks() + reviews().length + reports().length}
        else={<Empty title={uiText("nothingIsWaitingForYou")} />}
      >
        <Scroll style={grow} scrollbar={false}>
          <If when={asks()}>
            <View
              style={{
                ...row,
                gap: 6,
                paddingTop: 14,
                paddingBottom: 10,
                paddingHorizontal: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Caption
                text={uiText("waitingForYouCaption")}
                style={{ lineHeight: 12 }}
              />
              <Label size={10} line={12} tone="muted">
                {asks()}
              </Label>
            </View>
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
            <SectionHeader
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
                  detailTone={item().status === "blocked" ? "ink" : "amber"}
                  detailSize={item().status === "blocked" ? 11 : 12}
                  action={
                    item().status === "blocked"
                      ? uiText("decideAction")
                      : uiText("reviewAction")
                  }
                  actionLink
                  onPress={() => props.onTask?.(item().id)}
                >
                  <TaskGlyph status={item().status} size={14} />
                </PanelRow>
              )}
            </Each>
          </If>
          <If when={props.onRoutines && reports().length}>
            <SectionHeader
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
                    size={14}
                    tone={routine().unseenFailures ? "red" : "muted"}
                  />
                </PanelRow>
              )}
            </Each>
          </If>
        </Scroll>
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
          gap: 3,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <Label
          size={10}
          line={12}
          tone="amber"
          lines={1}
          style={{ letterSpacing: 1, textTransform: "uppercase" }}
        >
          {props.caption}
        </Label>
        <Label size={12} line={16}>
          {props.text}
        </Label>
      </View>
    );
  }
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If when={!props.conversationId}>
        <Header title={uiText("pending")} layout={props.layout}>
          <Label size={11} tone="muted">
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
              else={<Empty title={uiText("nothingIsWaitingForYou")} />}
            >
              <Scroll style={grow}>
                <View style={{ gap: 8, padding: 12 }}>
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
                          icon="tasks"
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
                          icon="routines"
                          attention={routine().unseenFailures > 0}
                          onPress={() => props.onRoutines?.(routine().id)}
                        />
                      )}
                    </Each>
                  </If>
                </View>
              </Scroll>
            </If>
          </If>
        }
      >
        <Scroll style={grow} scrollbar={false}>
          <PendingRow
            title={uiText("routines2")}
            icon="routines"
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
            onPress={() => props.onRoutines?.()}
          />
          <View
            style={{
              height: 31,
              paddingHorizontal: 16,
              justifyContent: "center",
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Caption
              text={uiText("confirmationRequest", {
                value1: items().length + proposals().length,
              })}
            />
          </View>
          <Each of={items()} key={(entry) => entry.id}>
            {(entry) => (
              <PendingRow
                title={entry().prompt}
                detail={uiText("questionFrom", {
                  value1: host.agent(entry().agentId)?.name ?? "Agent",
                  value2: entry().conversationId
                    ? ` · ${
                        host
                          .conversations()
                          .find((item) => item.id === entry().conversationId)
                          ?.name ?? "Conversation"
                      }`
                    : "",
                })}
                agent={entry().agentId}
                attention
                when={entry().createdAt}
                onPress={() => chosenId.set(entry().id)}
              />
            )}
          </Each>
          <Each of={proposals()} key={(item) => item.id}>
            {(item) => (
              <PendingRow
                title={String(
                  item().payload.title ??
                    item().payload.name ??
                    item().kind.replaceAll("_", " "),
                )}
                detail={uiText("proposalFromCaptain")}
                agent={host.captain()?.id}
                attention
                when={item().createdAt}
                onPress={() => proposalId.set(item().id)}
              />
            )}
          </Each>
          <View
            style={{
              height: 38,
              paddingHorizontal: 16,
              justifyContent: "center",
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Caption text={uiText("tasks", { length: reviews().length })} />
          </View>
          <Each of={reviews()} key={(item) => item.id}>
            {(item) => (
              <PendingRow
                title={`#${item().number} ${item().title}`}
                detail={`${item().status === "blocked" ? "Needs your decision" : "For you to check"}${
                  item().conversationId
                    ? ` · ${
                        host
                          .conversations()
                          .find((entry) => entry.id === item().conversationId)
                          ?.name ?? "Conversation"
                      }`
                    : ""
                }`}
                icon="tasks"
                attention
                when={item().updatedAt}
                onPress={() => props.onTask?.(item().id)}
              />
            )}
          </Each>
        </Scroll>
      </If>
      <If when={chosen()}>
        {(entry) => (
          <Modal
            title={uiText("questionFromWithCount", {
              value1: host.agent(entry().agentId)?.name ?? "Agent",
            })}
            height={phone() ? 474 : undefined}
            phone={phone()}
            sheet={phone()}
            hideHeader
            overPhoneNavigation
            onClose={() => chosenId.set("")}
          >
            <View
              style={{
                ...row,
                height: 44,
                paddingLeft: 16,
                paddingRight: 8,
                gap: 8,
                flexShrink: 0,
              }}
            >
              <AgentFace id={entry().agentId} size={20} />
              <Label size={14} line={20} weight={600} style={{ flex: 1 }}>
                {uiText("questionFromWithCount", {
                  value1: host.agent(entry().agentId)?.name ?? "Agent",
                })}
              </Label>
              <CloseButton size={32} onPress={() => chosenId.set("")} />
            </View>
            <Question
              item={entry()}
              sheet
              onDone={() => chosenId.set("")}
              onConversation={
                entry().conversationId && props.onConversation
                  ? () => props.onConversation!(entry().conversationId!)
                  : undefined
              }
            />
          </Modal>
        )}
      </If>
      <If when={proposal()}>
        {(entry) => (
          <Modal
            title={uiText("proposalFromCaptain")}
            height={phone() ? 430 : undefined}
            phone={phone()}
            sheet={phone()}
            overPhoneNavigation
            onClose={() => proposalId.set("")}
          >
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
