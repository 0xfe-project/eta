import type { ViewRef } from "nsh";
import type { Layout } from "../components";
import type { ChatListProps } from "./chat-list";
import type { Destination, Navigation } from "./routes";
import { View } from "nsh";
import { paneWidth } from "../app/pane-width";
import {
  colors,
  focusRing,
  Icon,
  Label,
  PaneHandle,
  row,
  sizes,
} from "../components";
import { pickerTarget } from "../components/element-picker";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { CaptainCard, RailCaptain } from "./captain";
import { ChatList } from "./chat-list";
import { RailButton } from "./rail-controls";
import { sections } from "./routes";

export function NavItem(props: {
  item: Destination;
  selected: boolean;
  layout: Layout;
  count?: number;
  onPress: () => void;
}) {
  const c = colors();
  const text = useText();
  const picker = pickerTarget(
    "NavItem",
    "apps/client/src/navigation/sidebar.tsx",
  );
  const wide = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={text(props.item[1])}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        ...(wide() ? row : { alignItems: "center", justifyContent: "center" }),
        height: wide() ? 28 : phone() ? 63 : 48,
        width: phone() ? "20%" : "100%",
        flexShrink: 0,
        paddingHorizontal: wide() ? 7 : 0,
        gap: wide() ? 8 : 4,
        backgroundColor:
          props.selected && !phone() ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <Icon
        name={props.item[2]}
        size={wide() ? 14 : phone() ? 22 : 18}
        tone={props.selected || wide() ? "ink" : "muted"}
      />
      <Label
        variant={wide() ? "body" : "caption"}
        tone={wide() || props.selected ? "ink" : "muted"}
        weight={phone() && props.selected ? 600 : 400}
        style={wide() ? { flex: 1 } : undefined}
      >
        {text(props.item[1])}
      </Label>
      <If when={(props.count ?? 0) > 0}>
        <Label
          variant={wide() ? "small" : "caption"}
          tone={wide() ? "ink" : "buttonInk"}
          style={
            wide()
              ? {}
              : {
                  position: "absolute",
                  height: 14,
                  minWidth: 14,
                  textAlign: "center",
                  top: phone() ? 8 : 4,
                  left: phone() ? "56%" : "62%",
                  backgroundColor: phone() ? c().blue : c().button,
                }
          }
        >
          {props.count}
        </Label>
      </If>
    </View>
  );
}

export function DesktopSidebar(
  props: Navigation &
    Omit<ChatListProps, "layout"> & {
      collapsed: boolean;
      onToggle: () => void;
    },
) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const check = () =>
    host.tasks().filter((task) => task.status === "in_review").length;
  let focusToggle = false;
  function toggleSidebar() {
    focusToggle = true;
    props.onToggle();
  }
  function attachToggle(node: ViewRef | null) {
    if (!node || !focusToggle) return;
    focusToggle = false;
    node.focus();
  }
  return (
    <View
      style={{
        width: props.collapsed ? sizes.rail : paneWidth("sidebar"),
        height: "100%",
        flexShrink: 0,
        borderRightWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <View
        style={{
          ...row,
          justifyContent: props.collapsed ? "center" : "space-between",
          height: 40,
          paddingHorizontal: props.collapsed ? 4 : 14,
          borderBottomWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <Label
          variant={props.collapsed ? "caption" : "subtitle"}
          tone={props.collapsed ? "muted" : "ink"}
          style={{ letterSpacing: props.collapsed ? 0.8 : 3.2 }}
        >
          ETA
        </Label>
        <If when={!props.collapsed}>
          <RailButton
            label={text("collapseSidebar")}
            icon="sidebar"
            size={24}
            width={16}
            iconSize={12}
            expanded
            attach={attachToggle}
            onPress={toggleSidebar}
          />
        </If>
      </View>
      <If
        when={props.collapsed}
        else={<CaptainCard onPress={() => props.onNavigate("captain")} />}
      >
        <RailCaptain
          selected={props.page === "captain"}
          onPress={() => props.onNavigate("captain")}
        />
      </If>
      <View
        web={{ element: "nav" }}
        style={{
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
          ...(props.collapsed
            ? { alignItems: "center", paddingVertical: 7 }
            : { paddingHorizontal: 7, paddingBottom: 5, gap: 1 }),
        }}
      >
        <If when={props.collapsed}>
          <RailButton
            label={text("expandSidebar")}
            icon="sidebar"
            size={22}
            expanded={false}
            attach={attachToggle}
            onPress={toggleSidebar}
          />
        </If>
        <Each of={sections}>
          {(item) => (
            <If
              when={props.collapsed}
              else={
                <NavItem
                  item={item()}
                  layout="desktop"
                  // Captain is a conversation: the Chat page stays the one selected.
                  selected={
                    props.page === item()[0] ||
                    (props.page === "captain" && item()[0] === "chat")
                  }
                  count={item()[0] === "tasks" ? check() : 0}
                  onPress={() => props.onNavigate(item()[0])}
                />
              }
            >
              <RailButton
                label={text(item()[1])}
                icon={item()[2]}
                selected={props.page === item()[0]}
                count={item()[0] === "tasks" ? check() : 0}
                onPress={() => props.onNavigate(item()[0])}
              />
            </If>
          )}
        </Each>
      </View>
      <ChatList
        layout="desktop"
        collapsed={props.collapsed}
        selected={props.selected}
        onConversation={props.onConversation}
        onCreate={props.onCreate}
        onArchived={props.onArchived}
      />
      <View
        style={{
          paddingHorizontal: 7,
          height: 37,
          justifyContent: "center",
          flexShrink: 0,
          ...(props.collapsed
            ? {
                alignItems: "center",
                borderTopWidth: 1,
                borderColor: c().border,
              }
            : {}),
        }}
      >
        <If
          when={props.collapsed}
          else={
            <NavItem
              item={["settings", "settings", "settings"]}
              layout="desktop"
              selected={props.page === "settings"}
              onPress={() => props.onNavigate("settings")}
            />
          }
        >
          <RailButton
            label={text("settings")}
            icon="settings"
            selected={props.page === "settings"}
            onPress={() => props.onNavigate("settings")}
          />
        </If>
      </View>
      <If when={!props.collapsed}>
        <PaneHandle pane="sidebar" />
      </If>
    </View>
  );
}
