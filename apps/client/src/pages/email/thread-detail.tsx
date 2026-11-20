import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  EmailThreadView,
} from "@eta/client-contracts";
import { Scroll, View } from "nsh";
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
  onContext: (message: EmailMessageView) => void;
}) {
  const c = colors();
  const host = useHost();
  const agentName = (id: string) => host.agent(id)?.name ?? uiText("agent");
  const projectName = (id: string) =>
    host.projects().find((item) => item.id === id)?.name ?? "Project";
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
              ? { padding: 16, gap: 12 }
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
              <View style={{ gap: 3 }}>
                <If when={agentMail()}>
                  <View style={{ ...row }}>
                    <EmailBadge />
                  </View>
                </If>
                <Label weight={600} size={18}>
                  {mailSubject(props.thread.subject)}
                </Label>
                <Label size={12} tone="muted" lines={1}>
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
                  <View
                    role="button"
                    accessibilityLabel={uiText("processingAgent", {
                      value1: agentName(assignment().agentId),
                    })}
                    onPress={() => props.onAssignment(assignment())}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      gap: 10,
                      paddingVertical: 10,
                      paddingHorizontal: 16,
                      marginHorizontal: -16,
                      minHeight: 76,
                      borderWidth: 1,
                      borderLeftWidth: 0,
                      borderRightWidth: 0,
                      borderColor: c().border,
                      cursor: "pointer",
                    }}
                  >
                    <AgentFace id={assignment().agentId} size={20} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Label size={10} tone="muted">
                        {uiText("processingAgent2")}
                      </Label>
                      <Label size={12} weight={600}>
                        {agentName(assignment().agentId)}
                      </Label>
                      <Label size={11} tone="muted">
                        {uiText("project", {
                          value1: projectName(assignment().projectId),
                        })}
                      </Label>
                    </View>
                    <Label size={11} tone="muted">
                      {uiText("view")}
                    </Label>
                    <Icon name="right" size={10} tone="muted" />
                  </View>
                }
              >
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
                    paddingVertical: 10,
                    borderBottomWidth: 1,
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
                  <Icon name="down" size={14} tone="muted" />
                </View>
              </If>
            )}
          </Each>
          <Each of={props.messages} key={(message) => message.id}>
            {(message) => (
              <MailMessage
                message={message()}
                subject={props.thread.subject}
                phone={props.phone}
                inlineContext={props.desktop}
                onContext={() => props.onContext(message())}
              />
            )}
          </Each>
          <Each of={props.proposals} key={(item) => item.id}>
            {(item) => (
              <View style={{ paddingTop: props.phone ? 0 : 12 }}>
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
            icon="return"
            size={40}
            tone="primary"
            onPress={props.onAssign}
          />
        </View>
      </If>
    </View>
  );
}
