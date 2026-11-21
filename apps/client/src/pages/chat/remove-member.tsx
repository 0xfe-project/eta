import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Label, Modal } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** The confirmation a member row's "Remove member" opens. */
export function RemoveMember(props: {
  info: ConversationInfo;
  members: MemberView[];
  phone: boolean;
  agentId: string;
  onClose: () => void;
}) {
  const host = useHost();
  const busy = signal(false);
  const error = signal("");
  async function remove() {
    if (busy()) return;
    busy.set(true);
    error.set("");
    try {
      await host.call("conversations", "remove", {
        conversationId: props.info.id,
        agentId: props.agentId,
      });
      props.onClose();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.set(false);
    }
  }
  return (
    <Modal
      title={uiText("removeMember")}
      width={432}
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation
      modalFocus
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 10 }}>
        <Label>
          {uiText("removeFrom", {
            memberName: host.agent(props.agentId)?.name ?? props.agentId,
            name: props.info.name,
          })}
        </Label>
        <Button
          label={uiText("removeMember")}
          disabled={busy() || props.members.length <= 1}
          onPress={() => void remove()}
        />
        <If when={error()}>
          <Label tone="red">{error()}</Label>
        </If>
        <Button
          label={uiText("cancel")}
          tone="ghost"
          disabled={busy()}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}
