import type {
  EmailAssignmentView,
  EmailMessageView,
} from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { Button, Modal } from "../../components";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { EmailInfo } from "./thread-context";

export function AssignmentDetail(props: {
  assignment: EmailAssignmentView;
  message?: EmailMessageView;
  rootMessageId?: string | null;
  phone: boolean;
  onClose: () => void;
  onOpenSession: () => void;
}) {
  const host = useHost();
  return (
    <Modal
      title={uiText("processingAgent2")}
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation={props.phone}
      side={!props.phone}
      width={360}
      height={props.phone ? undefined : "100%"}
      onClose={props.onClose}
    >
      <Scroll style={{ flexShrink: 1 }}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: props.phone ? 0 : 16,
          }}
        >
          <EmailInfo
            label={uiText("agent")}
            value={
              host.agent(props.assignment.agentId)?.name ?? uiText("agent")
            }
            phoneRow={props.phone}
            agentId={props.assignment.agentId}
          />
          <EmailInfo
            label={uiText("project2")}
            phoneRow={props.phone}
            value={
              host
                .projects()
                .find((item) => item.id === props.assignment.projectId)?.name
            }
          />
          <EmailInfo
            label={uiText("received")}
            phoneRow={props.phone}
            value={new Date(
              props.message?.createdAt ?? props.assignment.createdAt,
            ).toLocaleString(formatLocale(), {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })}
          />
          <EmailInfo
            label="Message-ID"
            phoneRow={props.phone}
            compact
            value={props.message?.rfcMessageId ?? props.rootMessageId}
          />
        </View>
      </Scroll>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: props.phone ? 16 : 8,
          paddingBottom: props.phone ? 24 : 16,
        }}
      >
        <Button
          label={uiText("openProcessingSession")}
          tone="primary"
          size={props.phone ? 40 : 32}
          onPress={props.onOpenSession}
        />
      </View>
    </Modal>
  );
}
