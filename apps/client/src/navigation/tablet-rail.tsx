import type { Navigation } from "./routes";
import { View } from "nsh";
import { colors, focusRing, sizes } from "../components";
import { avatar, space } from "../components/tokens";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { CaptainFace } from "./captain";
import { sections } from "./routes";
import { NavItem } from "./sidebar";

const captainHeight = 56;

export function TabletRail(props: Navigation) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const check = () =>
    host.tasks().filter((task) => task.status === "in_review").length;
  return (
    <View
      web={{ element: "nav" }}
      style={{
        width: sizes.rail,
        height: "100%",
        flexShrink: 0,
        padding: space[4],
        gap: space[4],
        borderRightWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <View
        role="button"
        accessibilityLabel={text("captain")}
        accessibilityState={{ selected: props.page === "captain" }}
        onPress={() => props.onNavigate("captain")}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c())}
        style={{
          height: captainHeight,
          backgroundColor:
            props.page === "captain" ? c().selected : "transparent",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <CaptainFace size={avatar.lg} />
      </View>
      <Each of={sections}>
        {(item) => (
          <NavItem
            item={item()}
            layout="tablet"
            selected={props.page === item()[0]}
            count={item()[0] === "tasks" ? check() : 0}
            onPress={() => props.onNavigate(item()[0])}
          />
        )}
      </Each>
      <View style={{ flex: 1 }} />
      <View
        style={{
          borderTopWidth: 1,
          borderColor: c().border,
          paddingBottom: space[8],
          paddingTop: space[4],
        }}
      >
        <NavItem
          item={["settings", "settings", "settings"]}
          layout="tablet"
          selected={props.page === "settings"}
          onPress={() => props.onNavigate("settings")}
        />
      </View>
    </View>
  );
}
