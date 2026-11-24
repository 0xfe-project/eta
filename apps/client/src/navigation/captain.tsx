import type { CaptainIdentityView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, focusRing, Label, row } from "../components";
import { AgentFace } from "../components/agent-face";
import { avatar, space, weight } from "../components/tokens";
import { uiText, useText } from "../i18n";
import { messageTime } from "../pages/chat/message-time";
import { useHost } from "../services/host";
import { CaptainContextRing } from "./captain-context-ring";

export function CaptainFace(props: { size: number }) {
  const host = useHost();
  return <AgentFace id={host.captain()?.id ?? "Captain"} size={props.size} />;
}

export function CaptainCard(props: { onPress: () => void }) {
  const text = useText();
  const host = useHost();
  const c = colors();
  const lastReply = () => {
    const id = host.section<CaptainIdentityView>(
      "captain",
      "identity",
    )?.conversationId;
    return id
      ? host.conversations().find((item) => item.id === id)?.lastMessageAt
      : undefined;
  };
  return (
    <View style={{ flexShrink: 0, padding: 14 }}>
      <View
        role="button"
        accessibilityLabel={text("captain")}
        onPress={() => props.onPress()}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c())}
        style={{
          ...row,
          alignItems: "flex-start",
          gap: space[12],
          minHeight: 54,
          paddingVertical: space[8],
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: c().border,
          backgroundColor: c().canvas,
          cursor: "pointer",
        }}
      >
        <CaptainFace size={avatar.md} />
        <View style={{ flex: 1, gap: 1 }}>
          <View style={{ ...row, gap: space[8] }}>
            <Label weight={weight.regular}>{text("captain")}</Label>
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
      </View>
    </View>
  );
}

export function RailCaptain(props: { selected: boolean; onPress: () => void }) {
  const c = colors();
  const text = useText();
  return (
    <View
      style={{
        height: 80,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: 7,
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
          gap: 3,
          backgroundColor: props.selected ? c().selected : "transparent",
          cursor: "pointer",
        }}
      >
        <CaptainContextRing>
          <CaptainFace size={36} />
        </CaptainContextRing>
        <Label variant="caption">{text("captain")}</Label>
      </View>
    </View>
  );
}
