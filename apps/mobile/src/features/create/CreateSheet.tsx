import { Text, View } from "nsh";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";

function Entry(props: {
  title: string;
  hint: string;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class={`h-[72px] shrink-0 flex-row items-center gap-3 px-4 active:bg-muted ${props.first ? "" : "border-t border-border"}`}
    >
      <View class="min-w-0 grow basis-0">
        <Text class="text-lead leading-[22px] text-foreground">
          {props.title}
        </Text>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {props.hint}
        </Text>
      </View>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}

/** 04: what the + on 对话 opens. */
export function CreateSheet(props: { open: boolean; onClose: () => void }) {
  const choose = (to: () => void) => {
    props.onClose();
    to();
  };
  return (
    <Sheet open={props.open} onClose={props.onClose} testID="create-sheet">
      <View class="border-t border-border-strong">
        <Entry
          first
          title={t("create.conversation.title")}
          hint={t("create.conversation.entry")}
          onPress={() => choose(go.newConversation)}
        />
        <Entry
          title={t("create.group.title")}
          hint={t("create.group.entry")}
          onPress={() => choose(go.newGroup)}
        />
        <Entry
          title={t("create.agent.title")}
          hint={t("create.agent.entry")}
          onPress={() => choose(go.newAgent)}
        />
      </View>
    </Sheet>
  );
}
