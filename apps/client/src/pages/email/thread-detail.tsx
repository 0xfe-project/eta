import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  EmailThreadView,
} from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { Button, colors, grow, Icon, Label, row } from "../../components";
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
  onAssign: () => void;
  onDelete: () => void;
  onMarkUnread: () => void;
  onAssignment: (assignment: EmailAssignmentView) => void;
  onContext: (message: EmailMessageView) => void;
}) {
  const c = colors();
  const host = useHost();
  return (
    <View style={grow}>
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: props.phone ? 16 : 20, gap: 12 }}>
          <View style={{ gap: 3 }}>
            <If
              when={
                isAgentMail(props.thread.subject) ||
                props.messages.some(
                  (message) => message.meta && message.meta.carrier !== "none",
                )
              }
            >
              <View style={{ ...row }}>
                <EmailBadge />
              </View>
            </If>
            <View style={{ ...row, gap: 6 }}>
              <Label weight={600} size={18} style={{ flex: 1 }}>
                {mailSubject(props.thread.subject)}
              </Label>
              <If when={!props.phone}>
                <Button label={uiText("assign2")} onPress={props.onAssign} />
                <Button
                  label={uiText("delete")}
                  tone="danger"
                  onPress={props.onDelete}
                />
                <Button
                  label={uiText("markUnread")}
                  onPress={props.onMarkUnread}
                />
              </If>
            </View>
            <If when={props.phone}>
              <Label size={12} tone="muted" lines={1}>
                {`${props.thread.peer} · ${props.thread.messageCount}${
                  props.thread.messageCount === 1 ? " message" : " messages"
                }`}
              </Label>
            </If>
          </View>
          <Each of={props.assignments} key={(assignment) => assignment.id}>
            {(assignment) => (
              <View
                role="button"
                accessibilityLabel={uiText("processingAgent", {
                  value1: host.agent(assignment().agentId)?.name ?? "Agent",
                })}
                onPress={() => props.onAssignment(assignment())}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  gap: 10,
                  paddingVertical: 10,
                  paddingHorizontal: props.phone ? 16 : 12,
                  marginHorizontal: props.phone ? -16 : 0,
                  minHeight: props.phone ? 76 : 0,
                  borderWidth: 1,
                  borderLeftWidth: props.phone ? 0 : 1,
                  borderRightWidth: props.phone ? 0 : 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={assignment().agentId} size={20} />
                <View style={{ flex: 1, gap: 2 }}>
                  <If when={props.phone}>
                    <Label size={10} tone="muted">
                      {uiText("processingAgent2")}
                    </Label>
                  </If>
                  <Label size={12} weight={600}>
                    {host.agent(assignment().agentId)?.name ?? uiText("agent")}
                  </Label>
                  <Label size={11} tone="muted">
                    {uiText("project", {
                      value1:
                        host
                          .projects()
                          .find((item) => item.id === assignment().projectId)
                          ?.name ?? "Project",
                    })}
                  </Label>
                </View>
                <Label size={11} tone="muted">
                  {uiText("view")}
                </Label>
                <Icon name="right" size={10} tone="muted" />
              </View>
            )}
          </Each>
          <Each of={props.messages} key={(message) => message.id}>
            {(message) => (
              <MailMessage
                message={message()}
                subject={props.thread.subject}
                phone={props.phone}
                onContext={() => props.onContext(message())}
              />
            )}
          </Each>
          <Each of={props.proposals} key={(item) => item.id}>
            {(item) => <EmailProposal item={item()} />}
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
