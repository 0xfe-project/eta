import type { Navigation } from "./routes";
import { View } from "nsh";
import { colors, focusRing, sizes } from "../components";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { CaptainFace } from "./captain";
import { sections } from "./routes";
import { NavItem } from "./sidebar";

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
        padding: 4,
        gap: 4,
        borderRightWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <View
        role="button"
        accessibilityLabel={text("captain")}
        onPress={() => props.onNavigate("captain")}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c())}
        style={{
          height: 56,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <CaptainFace size={28} />
      </View>
      <Each of={sections}>
        {(item) => (
          <NavItem
            item={item()}
            layout="tablet"
            // Captain is a conversation: the Chat page stays the one selected.
            selected={
              props.page === item()[0] ||
              (props.page === "captain" && item()[0] === "chat")
            }
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
          paddingBottom: 6,
          paddingTop: 3,
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
