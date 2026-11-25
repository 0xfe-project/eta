import type { ViewRef } from "nsh";
import { View } from "nsh";
import { grow, Header } from "../../components";
import { EmptyState } from "../../components/empty-state";
import { control, icon, space } from "../../components/tokens";
import { uiText, useText } from "../../i18n";
import { RailButton } from "../../navigation/rail-controls";
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
  /** A tablet's group list is folded away: the pane has no header of its own, so this gives it
   * one, with the button that brings the list back. */
  onExpandList?: () => void;
  attachExpandList?: (node: ViewRef | null) => void;
}) {
  const host = useHost();
  const text = useText();
  const noCaptain = () =>
    host.state().ops.length > 0 && !host.can("captain.direct");
  const page = () => (
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
  return (
    <If when={props.onExpandList} else={page()}>
      <View style={grow}>
        <Header
          title={text("chat")}
          layout="tablet"
          inset={space[12]}
          leading={
            <RailButton
              label={text("expandSidebar")}
              icon="sidebar"
              size={control.md}
              iconSize={icon.md}
              expanded={false}
              attach={props.attachExpandList}
              onPress={() => props.onExpandList?.()}
            />
          }
        />
        {page()}
      </View>
    </If>
  );
}
