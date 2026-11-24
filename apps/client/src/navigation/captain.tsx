import { View } from "nsh";
import { colors, focusRing, Label, row } from "../components";
import { AgentFace } from "../components/agent-face";
import { avatar, space } from "../components/tokens";
import { uiText, useText } from "../i18n";
import { messageTime } from "../pages/chat/message-time";
import { useHost } from "../services/host";
import { CaptainContextRing } from "./captain-context-ring";

/** A group row's height (chat-list-rows `groupRowHeight.regular`). */
const cardHeight = 52;
/** Captain atop the tablet rail: its face and its name. */
const railCaptainHeight = 80;

export function CaptainFace(props: { size: number }) {
  const host = useHost();
  return <AgentFace id={host.captain()?.id ?? "Captain"} size={props.size} />;
}

export function CaptainCard(props: {
  selected?: boolean;
  onPress: () => void;
}) {
  const text = useText();
  const host = useHost();
  const c = colors();
  const lastReply = () => host.captainConversation()?.lastMessageAt;
  // Flush under the header, one block with a divider: the same row as a group's below it.
  return (
    <View
      role="button"
      accessibilityLabel={text("captain")}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        minHeight: cardHeight,
        flexShrink: 0,
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        gap: space[2],
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <View style={{ ...row, gap: space[4] }}>
        <CaptainFace size={avatar.sm} />
        <Label variant="subtitle" lines={1} style={{ flex: 1 }}>
          {text("captain")}
        </Label>
        <Label variant="caption" tone="muted">
          {text(host.captain()?.status === "working" ? "working" : "idle")}
        </Label>
      </View>
      <Label variant="caption" tone="muted" lines={1}>
        {lastReply()
          ? uiText("captainLastReply", {
              time: messageTime(lastReply()!, false),
            })
          : text("captainNoConversation")}
      </Label>
    </View>
  );
}

export function RailCaptain(props: { selected: boolean; onPress: () => void }) {
  const c = colors();
  const text = useText();
  return (
    <View
      style={{
        height: railCaptainHeight,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        role="button"
        accessibilityLabel={text("captain")}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c())}
        style={{
          width: space[48],
          height: space[64],
          alignItems: "center",
          gap: space[2],
          backgroundColor: props.selected ? c().selected : "transparent",
          cursor: "pointer",
        }}
      >
        <CaptainContextRing>
          {/* design-value: sized to sit inside its 44px context ring */}
          <CaptainFace size={36} />
        </CaptainContextRing>
        <Label variant="caption">{text("captain")}</Label>
      </View>
    </View>
  );
}
