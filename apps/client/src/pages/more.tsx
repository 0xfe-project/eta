import type { Layout } from "../components";
import type { IconName } from "../components/icons";
import type { Page } from "../navigation/routes";
import { View } from "nsh";
import { useSavedHosts } from "../app/saved-hosts";
import { colors, grow, Header, Icon, Label, row } from "../components";
import { icon, space } from "../components/tokens";
import { useText } from "../i18n";
import { useHost } from "../services/host";

const rowHeight = 56;

export function More(props: {
  layout: Layout;
  onNavigate: (page: Page) => void;
  onSettings: () => void;
  onHosts?: () => void;
}) {
  const text = useText();
  const host = useHost();
  const savedHosts = useSavedHosts();
  const currentHost = () => {
    const origin = host.address()?.origin;
    return origin ? savedHosts.displayName(origin) : undefined;
  };
  return (
    <View style={grow}>
      <Header title={text("more")} layout={props.layout} />
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
      <If when={props.onHosts}>
        <MoreRow
          title={text("hosts")}
          icon="link"
          detail={currentHost()}
          onPress={props.onHosts!}
        />
      </If>
    </View>
  );
}
function MoreRow(props: {
  title: string;
  icon: IconName;
  detail?: string;
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
        height: rowHeight,
        paddingLeft: space[16],
        paddingRight: space[12],
        gap: space[12],
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: space[20],
          height: space[20],
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={props.icon} size={icon.md} />
      </View>
      <Label style={{ flex: 1 }}>{props.title}</Label>
      <If when={props.detail}>
        <Label variant="small" tone="muted" lines={1} style={{ flexShrink: 1 }}>
          {props.detail}
        </Label>
      </If>
      <Icon name="right" size={icon.md} />
    </View>
  );
}
