import { EmptyState } from "../../components/empty-state";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";

/**
 * The chat pane with no conversation in it: none chosen yet, or Captain's while it opens, when it
 * could not open, or on a host that has no Captain to talk to.
 */
export function ConversationEmpty(props: {
  captain: boolean;
  captainProblem?: unknown;
  onRetryCaptain?: () => void;
  onCreate: () => void;
}) {
  const host = useHost();
  const noCaptain = () =>
    host.state().ops.length > 0 && !host.can("captain.direct");
  return (
    <EmptyState
      size="page"
      status={
        !props.captain
          ? "empty"
          : noCaptain() || props.captainProblem !== undefined
            ? "error"
            : "loading"
      }
      loading={uiText("openingCaptain")}
      error={
        noCaptain()
          ? {
              art: "captain",
              tone: "quiet",
              title: uiText("captainUnavailable"),
              description: uiText("loadFailedUnsupported"),
            }
          : {
              title: uiText("captainDidNotOpen"),
              description: problemText(props.captainProblem),
              problem: props.captainProblem,
              retry: props.onRetryCaptain,
            }
      }
      empty={{
        art: "chats",
        title: uiText("noConversationSelected"),
        description: uiText("createAConversationOrSelectAn"),
        actions: [
          {
            label: uiText("newConversation"),
            icon: "plus",
            onPress: props.onCreate,
          },
        ],
      }}
    />
  );
}
