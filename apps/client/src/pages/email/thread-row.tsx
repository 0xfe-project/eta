import type { EmailThreadView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { uiText } from "../../i18n";
import { relativeTime } from "../../services/host";
import { EmailBadge, isAgentMail, mailDay, mailSubject } from "./message";

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
      hoverStyle={props.phone ? undefined : { backgroundColor: c().selected }}
      style={{
        ...row,
        ...(props.phone
          ? { minHeight: 76 }
          : {
              alignItems: "flex-start",
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 8,
              borderLeftWidth: props.selected ? 2 : 0,
              borderLeftColor: c().ink,
            }),
        borderBottomWidth: 1,
        borderBottomColor: c().border,
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
          size={props.phone ? 15 : 14}
          outlineOnly={props.phone}
          style={
            props.phone
              ? { marginLeft: 8, flexShrink: 0 }
              : { marginTop: 4, flexShrink: 0 }
          }
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
        hoverStyle={props.phone ? { backgroundColor: c().selected } : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          cursor: "pointer",
          ...(props.phone
            ? { gap: 2, paddingHorizontal: 11, paddingVertical: 8 }
            : { gap: 4 }),
        }}
      >
        <View
          style={{
            ...row,
            gap: 8,
            alignItems: props.phone ? "center" : "baseline",
          }}
        >
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
          <If
            when={props.phone}
            else={
              <Label size={11} line={16} tone="muted">
                {mailDay(props.thread.lastMessageAt)}
              </Label>
            }
          >
            <Label size={10} tone="muted">
              {relativeTime(props.thread.lastMessageAt)}
            </Label>
          </If>
          <If when={props.phone}>
            <Icon name="right" size={10} tone="muted" />
          </If>
        </View>
        <If
          when={props.phone}
          else={
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Label
                size={12}
                line={16}
                tone="muted"
                lines={1}
                style={{ flex: 1, minWidth: 0 }}
              >
                {props.thread.peer}
              </Label>
              <Label size={12} line={16} tone="muted">
                {props.thread.messageCount}
              </Label>
            </View>
          }
        >
          <Label size={12} tone="muted" lines={1}>
            {props.thread.messageCount > 1
              ? `${props.thread.peer} · ${props.thread.messageCount}`
              : props.thread.peer}
          </Label>
        </If>
        <Label size={12} line={16} tone="muted" lines={1}>
          {props.thread.lastMessage}
        </Label>
      </View>
    </View>
  );
}
