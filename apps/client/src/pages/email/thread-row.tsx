import type { EmailThreadView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { uiText } from "../../i18n";
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
  // A checked row reads like the open one: tinted, with the ink edge.
  const marked = () => props.selected || (!props.phone && props.checked);
  return (
    <View
      hoverStyle={
        props.phone || marked() ? undefined : { backgroundColor: c().selected }
      }
      style={{
        ...row,
        ...(props.phone
          ? { minHeight: 76, gap: 8, paddingLeft: 10 }
          : {
              alignItems: "flex-start",
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 8,
              borderLeftWidth: marked() ? 2 : 0,
              borderLeftColor: c().ink,
            }),
        borderBottomWidth: 1,
        borderBottomColor: c().border,
        backgroundColor: marked() ? c().selected : c().canvas,
      }}
    >
      <If when={!props.phone || props.selecting}>
        <CheckControl
          label={uiText("selectWithCount", {
            value1: props.thread.subject || "(No subject)",
          })}
          checked={props.checked}
          onChange={props.onCheck}
          size={14}
          indicatorStyle={
            props.checked ? { borderColor: c().button } : undefined
          }
          style={{ marginTop: 4, flexShrink: 0 }}
        />
      </If>
      <If when={props.phone}>
        <View style={{ width: 16, alignItems: "center", flexShrink: 0 }}>
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: props.thread.unread ? c().blue : "transparent",
            }}
          />
        </View>
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
            ? {
                ...row,
                alignSelf: "stretch",
                gap: 8,
                paddingRight: 12,
                paddingVertical: 8,
              }
            : { gap: 4 }),
        }}
      >
        <View
          style={props.phone ? { flex: 1, minWidth: 0, gap: 2 } : { gap: 4 }}
        >
          <View style={{ ...row, gap: 8, alignItems: "baseline" }}>
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
            <Label variant="caption" tone="muted">
              {mailDay(props.thread.lastMessageAt)}
            </Label>
          </View>
          <If
            when={props.phone}
            else={
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Label
                  variant="small"
                  tone="muted"
                  lines={1}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {props.thread.peer}
                </Label>
                <Label variant="small" tone="muted">
                  {props.thread.messageCount}
                </Label>
              </View>
            }
          >
            <Label variant="small" tone="mutedInk" lines={1}>
              {props.thread.messageCount > 1
                ? `${props.thread.peer} · ${props.thread.messageCount}`
                : props.thread.peer}
            </Label>
          </If>
          <Label variant="small" tone="muted" lines={1}>
            {props.thread.lastMessage}
          </Label>
        </View>
        <If when={props.phone}>
          <Icon name="right" size={14} />
        </If>
      </View>
    </View>
  );
}
