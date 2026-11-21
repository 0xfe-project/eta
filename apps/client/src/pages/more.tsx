import type { EmailThreadView } from "@eta/client-contracts";
import type { Layout } from "../components";
import type { IconName } from "../components/icons";
import type { Page } from "../navigation/routes";
import { View } from "nsh";
import { colors, grow, Header, Icon, Label, row } from "../components";
import { useText } from "../i18n";
import { useHost } from "../services/host";

export function More(props: {
  layout: Layout;
  onNavigate: (page: Page) => void;
  onSettings: () => void;
}) {
  const host = useHost();
  const text = useText();
  return (
    <View style={grow}>
      <Header title={text("more")} layout={props.layout} />
      <MoreRow
        title={text("email")}
        icon="email"
        count={
          host
            .list<EmailThreadView>("email", "threads")
            .filter((thread) => thread.unread).length
        }
        onPress={() => props.onNavigate("email")}
      />
      <MoreRow
        title={text("plugins")}
        icon="plugins"
        onPress={() => props.onNavigate("plugins")}
      />
      <MoreRow
        title={text("settings")}
        icon="settings"
        onPress={props.onSettings}
      />
    </View>
  );
}
function MoreRow(props: {
  title: string;
  icon: IconName;
  count?: number;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      activeStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 56,
        paddingLeft: 16,
        paddingRight: 12,
        gap: 12,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={props.icon} size={18} />
      </View>
      <Label style={{ flex: 1 }}>{props.title}</Label>
      <If when={props.count}>
        <View
          style={{
            height: 14,
            minWidth: 14,
            paddingHorizontal: 3,
            backgroundColor: c().blue,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Label variant="caption" style={{ color: "#ffffff" }}>
            {props.count}
          </Label>
        </View>
      </If>
      <Icon name="right" size={14} />
    </View>
  );
}
