import type {
  CaptainOperationView,
  RoutineSummary,
} from "@eta/client-contracts";
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
import { taskNeedsAttention } from "../tasks/status";
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
      <If
        when={phone() && !props.conversationId}
        else={
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
                    text={uiText("tasksToCheck", { length: reviews().length })}
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
            height={474}
            phone
            sheet
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
            height={430}
            phone
            sheet
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
