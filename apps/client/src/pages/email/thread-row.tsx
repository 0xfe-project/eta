import type { EmailThreadView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { uiText } from "../../i18n";
import { relativeTime } from "../../services/host";
import { EmailBadge, isAgentMail, mailSubject } from "./message";

export function ThreadRow(props: {
  thread: EmailThreadView;
  selected: boolean;
  checked: boolean;
  selecting: boolean;
  phone: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        minHeight: props.phone ? 76 : 81,
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: props.selected ? c().selected : c().canvas,
      }}
    >
      <If when={!props.phone || props.selecting}>
        <CheckControl
          label={uiText("selectWithCount", {
            value1: props.thread.subject || "(No subject)",
          })}
          checked={props.checked}
          onChange={props.onCheck}
          size={15}
          outlineOnly
          style={{ marginLeft: 8, flexShrink: 0 }}
        />
      </If>
      <If when={props.phone && !props.selecting}>
        <View
          style={{
            width: 7,
            height: 7,
            marginLeft: 16,
            alignSelf: "flex-start",
            marginTop: 18,
            backgroundColor: props.thread.unread ? c().blue : "transparent",
          }}
        />
      </If>
      <View
        role="button"
        accessibilityLabel={props.thread.subject || uiText("noSubject")}
        onPress={() =>
          props.phone && props.selecting
            ? props.onCheck(!props.checked)
            : props.onOpen()
        }
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          flex: 1,
          minWidth: 0,
          gap: 2,
          paddingHorizontal: props.phone ? 11 : 8,
          paddingVertical: 8,
          cursor: "pointer",
        }}
      >
        <View style={{ ...row, gap: 8 }}>
          <If when={isAgentMail(props.thread.subject)}>
            <EmailBadge />
          </If>
          <Label
            lines={1}
            weight={props.thread.unread ? 600 : 400}
            style={{ flex: 1 }}
          >
            {mailSubject(props.thread.subject)}
          </Label>
          <Label size={10} tone="muted">
            {relativeTime(props.thread.lastMessageAt)}
          </Label>
          <If when={props.phone}>
            <Icon name="right" size={10} tone="muted" />
          </If>
        </View>
        <Label size={12} tone="muted" lines={1}>
          {props.thread.messageCount > 1
            ? `${props.thread.peer} · ${props.thread.messageCount}`
            : props.thread.peer}
        </Label>
        <Label size={12} tone="muted" lines={1}>
          {props.thread.lastMessage}
        </Label>
      </View>
    </View>
  );
}
