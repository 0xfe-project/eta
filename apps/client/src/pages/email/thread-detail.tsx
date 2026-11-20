import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  EmailThreadView,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { AssignmentInline } from "./assignment-detail";
import { EmailBadge, isAgentMail, MailMessage, mailSubject } from "./message";
import { EmailProposal } from "./proposal";

export function ThreadDetail(props: {
  thread: EmailThreadView;
  messages: EmailMessageView[];
  assignments: EmailAssignmentView[];
  proposals: EmailProposalView[];
  phone: boolean;
  desktop: boolean;
  onAssign: () => void;
  onDelete: () => void;
  onMarkUnread: () => void;
  onAssignment: (assignment: EmailAssignmentView) => void;
  onOpenSession: (assignment: EmailAssignmentView) => void;
}) {
  const c = colors();
  const host = useHost();
  // Off phones a processing row opens in place; the id of the open one.
  const open = signal("");
  const agentName = (id: string) => host.agent(id)?.name ?? uiText("agent");
  const projectName = (id: string) =>
    host.projects().find((item) => item.id === id)?.name ?? "Project";
  // A proposal shows in its processing agent's log, oldest first; the rest,
  // still waiting for the user, sit under the messages.
  const sessionProposals = (sessionId: string) =>
    props.proposals
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  const looseProposals = () =>
    props.proposals.filter(
      (item) =>
        (item.status === "pending" || item.status === "failed") &&
        !props.assignments.some(
          (assignment) => assignment.sessionId === item.sessionId,
        ),
    );
  const agentMail = () =>
    isAgentMail(props.thread.subject) ||
    props.messages.some(
      (message) => message.meta && message.meta.carrier !== "none",
    );
  return (
    <View style={grow}>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={
            props.phone
              ? undefined
              : props.desktop
                ? {
                    width: "100%",
                    maxWidth: 720,
                    alignSelf: "center",
                    paddingBottom: 24,
                  }
                : { paddingHorizontal: 24, paddingBottom: 24 }
          }
        >
          <If
            when={!props.phone}
            else={
              <View
                style={{
                  gap: 6,
                  padding: 16,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <If when={agentMail()}>
                  <View style={{ ...row }}>
                    <EmailBadge tall />
                  </View>
                </If>
                <Label weight={600} size={18} line={24}>
                  {mailSubject(props.thread.subject)}
                </Label>
                <Label size={12} line={16} tone="muted" lines={1}>
                  {`${props.thread.peer} · ${props.thread.messageCount}${
                    props.thread.messageCount === 1 ? " message" : " messages"
                  }`}
                </Label>
              </View>
            }
          >
            <View
              style={{
                ...row,
                alignItems: "flex-start",
                gap: 12,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <View style={{ ...row, gap: 8 }}>
                  <If when={agentMail()}>
                    <EmailBadge />
                  </If>
                  <Label
                    weight={600}
                    size={18}
                    line={24}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {mailSubject(props.thread.subject)}
                  </Label>
                </View>
                <Label size={12} line={16} tone="muted" lines={1}>
                  {props.thread.peer}
                </Label>
              </View>
              <ActionMenu label={uiText("emailActions")}>
                <ActionItem
                  label={uiText("markUnread")}
                  onSelect={props.onMarkUnread}
                />
                <ActionItem
                  label={uiText("delete")}
                  onSelect={props.onDelete}
                />
              </ActionMenu>
              <Button
                label={uiText("handToAnAgent")}
                tone="primary"
                icon="send"
                iconSize={14}
                size={28}
                style={{ paddingHorizontal: 12, gap: 6 }}
                onPress={props.onAssign}
              />
            </View>
          </If>
          <Each of={props.assignments} key={(assignment) => assignment.id}>
            {(assignment) => (
              <If
                when={!props.phone}
                else={
                  <>
                    <View
                      role="button"
                      accessibilityLabel={uiText("processingAgent", {
                        value1: agentName(assignment().agentId),
                      })}
                      onPress={() => props.onAssignment(assignment())}
                      hoverStyle={{ backgroundColor: c().selected }}
                      style={{
                        ...row,
                        gap: 12,
                        paddingVertical: 12,
                        paddingLeft: 16,
                        paddingRight: 12,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        cursor: "pointer",
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Label size={10} line={12} tone="muted">
                          {uiText("processingAgent2")}
                        </Label>
                        <View style={{ ...row, gap: 8 }}>
                          <AgentFace id={assignment().agentId} size={16} />
                          <Label size={14} line={20} weight={600} lines={1}>
                            {agentName(assignment().agentId)}
                          </Label>
                        </View>
                        <Label size={12} line={16} tone="muted" lines={1}>
                          {uiText("project", {
                            value1: projectName(assignment().projectId),
                          })}
                        </Label>
                      </View>
                      <View style={{ ...row, gap: 4, flexShrink: 0 }}>
                        <Label size={12} line={16} tone="mutedInk">
                          {uiText("view")}
                        </Label>
                        <Icon name="right" size={14} />
                      </View>
                    </View>
                    <If when={sessionProposals(assignment().sessionId).length}>
                      <View
                        style={{
                          gap: 12,
                          padding: 16,
                          borderBottomWidth: 1,
                          borderColor: c().border,
                        }}
                      >
                        <Each
                          of={sessionProposals(assignment().sessionId)}
                          key={(item) => item.id}
                        >
                          {(item) => <EmailProposal item={item()} />}
                        </Each>
                      </View>
                    </If>
                  </>
                }
              >
                <View
                  role="button"
                  accessibilityLabel={uiText("processingAgent", {
                    value1: agentName(assignment().agentId),
                  })}
                  accessibilityState={{ expanded: open() === assignment().id }}
                  onPress={() =>
                    open.set(open() === assignment().id ? "" : assignment().id)
                  }
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    gap: 12,
                    paddingVertical: 10,
                    borderBottomWidth: open() === assignment().id ? 0 : 1,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Label size={14} line={18} weight={600}>
                      {uiText("processingAgent", {
                        value1: agentName(assignment().agentId),
                      })}
                    </Label>
                    <Label size={12} line={16} tone="muted">
                      {uiText("project", {
                        value1: projectName(assignment().projectId),
                      })}
                    </Label>
                  </View>
                  <Label size={12} line={16} tone="muted">
                    {uiText("view")}
                  </Label>
                  <View
                    style={{
                      transform:
                        open() === assignment().id
                          ? [{ rotate: "180deg" }]
                          : undefined,
                    }}
                  >
                    <Icon name="down" size={14} tone="muted" />
                  </View>
                </View>
                <If when={open() === assignment().id}>
                  <AssignmentInline
                    assignment={assignment()}
                    proposals={sessionProposals(assignment().sessionId)}
                    onOpenSession={() => props.onOpenSession(assignment())}
                  />
                </If>
              </If>
            )}
          </Each>
          <Each of={props.messages} key={(message) => message.id}>
            {(message) => (
              <MailMessage
                message={message()}
                subject={props.thread.subject}
                phone={props.phone}
                inlineContext={props.desktop || props.phone}
              />
            )}
          </Each>
          <Each of={looseProposals()} key={(item) => item.id}>
            {(item) => (
              <View
                style={
                  props.phone
                    ? { paddingHorizontal: 16, paddingBottom: 16 }
                    : { paddingTop: 12 }
                }
              >
                <EmailProposal item={item()} />
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <If when={props.phone}>
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            paddingHorizontal: 16,
            paddingVertical: 8,
          }}
        >
          <Button
            label={uiText("handToAnAgent")}
            icon="send"
            iconSize={14}
            size={40}
            labelSize={13}
            tone="primary"
            style={{ gap: 8 }}
            onPress={props.onAssign}
          />
        </View>
      </If>
    </View>
  );
}
