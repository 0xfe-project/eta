import { Button, Empty } from "../../components";
import { uiText } from "../../i18n";
export function ConversationEmpty(props: {
  captain: boolean;
  onCreate: () => void;
}) {
  return (
    <Empty
      title={props.captain ? "Captain" : uiText("noConversationSelected")}
      description={
        props.captain
          ? uiText("captainWillAppearWhenItIs")
          : uiText("createAConversationOrSelectAn")
      }
      icon="chat"
    >
      <If when={!props.captain}>
        <Button
          label={uiText("newConversation")}
          icon="plus"
          onPress={props.onCreate}
        />
      </If>
    </Empty>
  );
}
