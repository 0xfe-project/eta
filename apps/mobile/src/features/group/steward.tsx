// 03l Choose steward. A steward is the group's own: one of its members, or none at all.

import type { MemberView } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { call } from "../../wire/target";
import { act, agentName, SheetRow, SheetTitle } from "./shared";

const Check = () => <Icon name="check" size={16} />;
const NoAvatar = () => <View class="size-5 shrink-0" />;

export function StewardSheet(props: {
  open: boolean;
  id: string;
  stewardId: string | null;
  members: MemberView[];
  onClose: () => void;
}) {
  const pick = (agentId: string | null) =>
    act(
      call("conversations", "setSteward", {
        conversationId: props.id,
        agentId,
      }),
      props.onClose,
    );
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("group.steward")} body={t("group.steward.hint")} />
      <Scroll style={{ maxHeight: 416 }}>
        <Each of={props.members} key={(member) => member.agentId}>
          {(member) => (
            <SheetRow
              title={agentName(member().agentId)}
              testID={`steward-${member().agentId}`}
              leading={<AgentAvatar id={member().agentId} size={20} />}
              trailing={
                props.stewardId === member().agentId ? <Check /> : undefined
              }
              onPress={() => pick(member().agentId)}
            />
          )}
        </Each>
        <SheetRow
          title={t("group.steward.none")}
          testID="steward-none"
          leading={<NoAvatar />}
          trailing={props.stewardId === null ? <Check /> : undefined}
          onPress={() => pick(null)}
        />
      </Scroll>
    </Sheet>
  );
}
