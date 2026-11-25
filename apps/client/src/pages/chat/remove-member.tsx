import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import { signal } from "nsh";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { ConfirmDialog } from "../../ui";

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
      error.set(problemText(cause));
    } finally {
      busy.set(false);
    }
  }
  return (
    <ConfirmDialog
      title={uiText("removeMember")}
      description={uiText("removeFrom", {
        memberName: host.agent(props.agentId)?.name ?? props.agentId,
        name: props.info.name,
      })}
      confirmLabel={uiText("removeMember")}
      tone="danger"
      phone={props.phone}
      busy={busy()}
      disabled={props.members.length <= 1}
      error={error()}
      modalFocus
      onConfirm={() => void remove()}
      onClose={props.onClose}
    />
  );
}
