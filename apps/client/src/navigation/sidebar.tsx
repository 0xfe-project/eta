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
import { border, control, icon, space, weight } from "../components/tokens";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { CaptainCard, RailCaptain } from "./captain";
import { ChatList } from "./chat-list";
import { RailButton } from "./rail-controls";
import { sections } from "./routes";

/** A destination: a row in the wide sidebar, a cell in the tablet rail, a tab on a phone (the
 * tab bar's height inside its top border). */
const itemHeight = {
  wide: 28,
  /** A section edge to edge in the sidebar, as tall as its header. */
  flush: space[40],
  rail: 48,
  phone: sizes.phoneNav - border.hair,
} as const;
/** Five tabs across a phone. */
const phoneItemWidth = "20%";
/** An unread count over a rail or tab icon. */
const badgeHeight = 16;
const footerHeight = 36;
/** The wordmark's own spacing, not a caption's. */
const wordmarkTracking = 3.2;

export function NavItem(props: {
  item: Destination;
  selected: boolean;
  layout: Layout;
  count?: number;
  /** Edge to edge with a divider on that side: the sidebar's sections
   * (under them, like the rows below) and Settings (over it, at the foot). */
  flush?: "top" | "bottom";
  /** One step down: the section rows under the wordmark, not Settings. */
  compact?: boolean;
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
        height: wide()
          ? props.compact
            ? space[32]
            : props.flush
              ? itemHeight.flush
              : itemHeight.wide
          : phone()
            ? itemHeight.phone
            : itemHeight.rail,
        width: phone() ? phoneItemWidth : "100%",
        flexShrink: 0,
        paddingHorizontal: wide()
          ? props.compact
            ? space[12]
            : props.flush
              ? space[16]
              : space[8]
          : 0,
        ...(props.flush === "bottom"
          ? { borderBottomWidth: 1, borderColor: c().border }
          : props.flush === "top"
            ? { borderTopWidth: 1, borderColor: c().border }
            : {}),
        gap: wide() ? (props.compact ? space[4] : space[8]) : space[4],
        backgroundColor:
          props.selected && !phone() ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <Icon
        name={props.item[2]}
        size={
          wide()
            ? props.compact
              ? icon.sm
              : icon.md
            : phone()
              ? icon.lg
              : icon.md
        }
        tone={props.selected || wide() ? "ink" : "muted"}
      />
      <Label
        variant={wide() ? (props.compact ? "small" : "body") : "caption"}
        tone={wide() || props.selected ? "ink" : "muted"}
        weight={phone() && props.selected ? weight.strong : weight.regular}
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
                  height: badgeHeight,
                  minWidth: badgeHeight,
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
          height: space[40],
          paddingHorizontal: props.collapsed ? space[4] : space[16],
          borderBottomWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <If when={props.collapsed}>
          <RailButton
            label={text("expandSidebar")}
            icon="sidebar"
            size={control.md}
            iconSize={icon.md}
            expanded={false}
            attach={attachToggle}
            onPress={toggleSidebar}
          />
        </If>
        <If when={!props.collapsed}>
          <View
            style={{
              ...row,
              width: "100%",
              justifyContent: "space-between",
            }}
          >
            <Label
              variant="subtitle"
              tone="ink"
              style={{ letterSpacing: wordmarkTracking }}
            >
              ETA
            </Label>
            <RailButton
              label={text("collapseSidebar")}
              icon="sidebar"
              size={control.md}
              iconSize={icon.md}
              expanded
              attach={attachToggle}
              onPress={toggleSidebar}
            />
          </View>
        </If>
      </View>
      <If
        when={props.collapsed}
        else={
          <CaptainCard
            selected={props.page === "captain"}
            onPress={() => props.onNavigate("captain")}
          />
        }
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
          ...(props.collapsed
            ? {
                alignItems: "center",
                paddingVertical: space[8],
                borderBottomWidth: 1,
                borderColor: c().border,
              }
            : {}),
        }}
      >
        <Each of={sections}>
          {(item) => (
            <If
              when={props.collapsed}
              else={
                <NavItem
                  item={item()}
                  layout="desktop"
                  flush="bottom"
                  compact
                  selected={props.page === item()[0]}
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
      <If
        when={props.collapsed}
        else={
          <NavItem
            item={["settings", "settings", "settings"]}
            layout="desktop"
            flush="top"
            selected={props.page === "settings"}
            onPress={() => props.onNavigate("settings")}
          />
        }
      >
        <View
          style={{
            height: footerHeight,
            justifyContent: "center",
            alignItems: "center",
            flexShrink: 0,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <RailButton
            label={text("settings")}
            icon="settings"
            selected={props.page === "settings"}
            onPress={() => props.onNavigate("settings")}
          />
        </View>
      </If>
      <If when={!props.collapsed}>
        <PaneHandle pane="sidebar" />
      </If>
    </View>
  );
}
