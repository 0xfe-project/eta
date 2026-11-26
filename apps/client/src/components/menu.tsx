import type { JSX, ViewStyle } from "nsh";
import type { Layout } from "./theme";
import { context, platform, reduceMotion, safeArea, signal, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Popover, Sheet } from "nsh/base";
import { Compact } from "./density";
import { EmptyState } from "./empty-state";
import { menuMotion } from "./motion";
import { screenInsets } from "./safe-area";
import { SmoothScroll } from "./smooth-scroll";
import { colors, focusRing, Screen } from "./theme";
import { space } from "./tokens";

/** The grabber atop a phone sheet. */
const grabberWidth = 36;
/** How much of the screen a phone's menu sheet may take. */
const sheetMaxHeight = "80%";

/** How a menu shows: a sheet at the bottom of the screen, or a popup at its trigger. */
export type MenuPresentation = "sheet" | "popup";

/**
 * How a menu shows in a layout. The layout decides, not the platform: a
 * phone's menu is the design's sheet at the bottom (full width, a grabber,
 * 52pt rows); a tablet's and a desktop's is a popup at the trigger, so an
 * iPad or an unfolded foldable, which draw the tablet layout, get the popup.
 */
export function menuPresentation(layout: Layout): MenuPresentation {
  return layout === "phone" ? "sheet" : "popup";
}

/** The NSH component that draws a menu. */
export type MenuEngine = "menu" | "popover" | "sheet";

/**
 * Which NSH component draws a presentation on this platform. A popup is
 * NSH's `Menu` on a desktop and a `Popover` on touch. A sheet is always eta's
 * `Sheet`: unlike NSH's `Menu`, it lets a short menu keep the same framing
 * and minimum height as a long one.
 */
export function menuEngine(
  presentation: MenuPresentation,
  desktop: boolean = platform.desktop,
): MenuEngine {
  if (presentation === "popup") return desktop ? "menu" : "popover";
  return "sheet";
}

interface MediaQueryHost {
  matchMedia?: (query: string) => { matches: boolean };
}

/** Whether a browser's primary pointer matches `query`, else `fallback`. */
function pointerMatches(query: string, fallback: boolean) {
  if (platform.os !== "web") return fallback;
  const match = (globalThis as MediaQueryHost).matchMedia?.(query);
  return match ? match.matches : fallback;
}

/**
 * A finger is the pointer: menu rows and tap areas grow to the touch size,
 * whatever the layout (it does not change how a menu shows).
 */
export const touchScreen = pointerMatches(
  "(pointer: coarse)",
  !platform.desktop,
);

/**
 * The pointer can rest over a view, so hover feedback means something there;
 * a touch would leave it behind. NSH reports no pointer capability, so a
 * native app counts its desktops (a mouse), a browser asks its media query.
 */
export const canHover = pointerMatches("(hover: hover)", platform.desktop);

/** The least height of a menu row a finger presses, in a popup. */
export const touchRow = 44;

/** The menu around a `MenuRow`: whether NSH's `Menu` draws it, how it shows, and how to close it. */
const MenuHost = context<{
  native: boolean;
  sheet: boolean;
  close: () => void;
}>({ native: true, sheet: false, close: () => {} });

/** Whether the menu around it is a sheet: rows take the sheet's padding. */
export function inSheet() {
  return MenuHost().sheet;
}

/** The grabber at the top of a sheet. */
function Grabber() {
  const c = colors();
  return (
    <View
      testID="menu-grabber"
      style={{
        alignItems: "center",
        paddingTop: space[8],
        paddingBottom: space[4],
      }}
    >
      <View
        style={{
          width: grabberWidth,
          height: space[4],
          backgroundColor: c().strong,
        }}
      />
    </View>
  );
}

/**
 * A menu its trigger opens, shown as the layout says (`menuPresentation`): a
 * phone's sheet at the bottom with a grabber, else a popup at the trigger in
 * `popupStyle`. Its rows are `MenuRow`s, its rules `MenuRule`s.
 */
export function MenuFrame(props: {
  trigger: JSX.Element;
  /** The popup's look: width, border, padding. */
  popupStyle: ViewStyle;
  /** The sheet's, over its full width, top rule and canvas. */
  sheetStyle?: ViewStyle;
  /** Drawn under the sheet's grabber, such as a title row. */
  sheetHeader?: JSX.Element;
  align?: "start" | "end";
  offset?: number;
  margin?: number;
  /** Open (controlled), with `onOpenChange`; else it keeps its own state. */
  open?: boolean;
  /** The trigger opens nothing. */
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What the menu says while it has no options to choose (one muted line): pass it only then. */
  empty?: string;
  children?: JSX.Element;
}) {
  const c = colors();
  const layout = Screen();
  const sheet = () => menuPresentation(layout()) === "sheet";
  const engine = () => menuEngine(menuPresentation(layout()));
  const own = signal(false);
  const opened = () => !props.disabled && (props.open ?? own());
  const change = (next: boolean) => {
    if (next && props.disabled) return;
    own.set(next);
    props.onOpenChange?.(next);
  };
  const close = () => change(false);
  const surfaceInsets = screenInsets();
  const bottomInset = () => Math.max(safeArea().bottom, surfaceInsets().bottom);
  // A popup grows out of its trigger's corner and goes back into it.
  const rise = () => menuMotion(props.align ?? "start", reduceMotion());
  const sheetStyle = (): ViewStyle => {
    const baseBottom =
      typeof props.sheetStyle?.paddingBottom === "number"
        ? props.sheetStyle.paddingBottom
        : space[8];
    return {
      width: "100%",
      borderTopWidth: 1,
      borderColor: c().strong,
      backgroundColor: c().canvas,
      ...props.sheetStyle,
      paddingBottom: baseBottom + bottomInset(),
    };
  };
  // The popover's rows scroll within the room on its side, as a menu's do.
  const room = signal<number | undefined>(undefined);
  const contentBody = (native: boolean) => (
    <>
      <If when={sheet()}>
        <Grabber />
        {props.sheetHeader}
      </If>
      <Compact>
        {props.children}
        <If when={props.empty}>
          {(text) => <MenuEmpty text={text()} native={native} />}
        </If>
      </Compact>
    </>
  );
  const content = (native: boolean) => (
    <MenuHost.Provider value={{ native, sheet: sheet(), close }}>
      {contentBody(native)}
    </MenuHost.Provider>
  );
  const viaMenu = () => (
    <Menu
      placement="bottom"
      align={props.align ?? "start"}
      offset={props.offset ?? 3}
      margin={props.margin}
      open={props.disabled ? false : props.open}
      onOpenChange={(event) => change(event.open)}
      popupStyle={
        sheet() ? sheetStyle() : { ...props.popupStyle, ...rise().style }
      }
      popupStartingStyle={sheet() ? undefined : rise().starting}
      popupEndingStyle={sheet() ? undefined : rise().ending}
      backdropStyle={{ backgroundColor: c().sheetScrim }}
      trigger={props.trigger}
    >
      {content(true)}
    </Menu>
  );
  const viaPopover = () => (
    <MenuHost.Provider value={{ native: false, sheet: false, close }}>
      <Popover
        placement="bottom"
        align={props.align ?? "start"}
        offset={props.offset ?? 3}
        margin={props.margin ?? 8}
        open={opened()}
        onOpenChange={(event) => change(event.open)}
        onPosition={(event) => room.set(event.available.height)}
        popupStyle={{ ...props.popupStyle, ...rise().style }}
        popupStartingStyle={rise().starting}
        popupEndingStyle={rise().ending}
        trigger={props.trigger}
      >
        <SmoothScroll
          role="menu"
          style={{ maxHeight: room(), flexShrink: 1 }}
          scrollbar={false}
        >
          {contentBody(false)}
        </SmoothScroll>
      </Popover>
    </MenuHost.Provider>
  );
  const viaSheet = () => (
    <>
      <View
        role="button"
        accessibilityState={{ expanded: opened() }}
        onPress={() => change(!opened())}
        focusVisibleStyle={focusRing(c())}
        style={{ minWidth: 0 }}
      >
        {props.trigger}
      </View>
      {/* The sheet renders children in a top layer, so provide its menu host around it. */}
      <MenuHost.Provider value={{ native: false, sheet: true, close }}>
        <Sheet
          side="bottom"
          open={opened()}
          onOpenChange={(event) => change(event.open)}
          popupStyle={{ ...sheetStyle(), maxHeight: sheetMaxHeight }}
          backdropStyle={{ backgroundColor: c().sheetScrim }}
        >
          <SmoothScroll role="menu" style={{ flexShrink: 1 }} scrollbar={false}>
            {contentBody(false)}
          </SmoothScroll>
        </Sheet>
      </MenuHost.Provider>
    </>
  );
  return (
    <If
      when={engine() === "menu"}
      else={
        <If when={engine() === "popover"} else={viaSheet()}>
          {viaPopover()}
        </If>
      }
    >
      {viaMenu()}
    </If>
  );
}

/** A menu with nothing to choose: one muted line, no art, no button. In a menu the platform
 * draws, a disabled item holds it. */
function MenuEmpty(props: { text: string; native: boolean }) {
  const line = (
    <EmptyState
      size="menu"
      status="empty"
      loading={null}
      error={null}
      empty={{ title: props.text }}
      style={inSheet() ? { paddingHorizontal: space[16] } : undefined}
    />
  );
  return (
    <If when={props.native} else={line}>
      <MenuItem disabled accessibilityLabel={props.text}>
        {line}
      </MenuItem>
    </If>
  );
}

/**
 * A row of a `MenuFrame`: NSH's `MenuItem` where its `Menu` draws the menu,
 * else a pressable row that chooses and closes the popover or sheet.
 */
export function MenuRow(props: {
  label: string;
  /** A second line screen readers say, such as a status's hint. */
  description?: string;
  role?: "menuitem" | "menuitemradio";
  checked?: boolean;
  disabled?: boolean;
  style: ViewStyle;
  onSelect: () => void;
  children?: JSX.Element;
}) {
  const c = colors();
  const host = MenuHost();
  const hover = canHover ? { backgroundColor: c().selected } : undefined;
  return (
    <If
      when={host.native}
      else={
        <View
          role={props.role ?? "menuitem"}
          accessibilityLabel={props.label}
          accessibilityDescription={props.description}
          accessibilityState={{
            checked: props.checked,
            disabled: props.disabled,
          }}
          disabled={props.disabled}
          onPress={() => {
            host.close();
            props.onSelect();
          }}
          hoverStyle={hover}
          activeStyle={{ backgroundColor: c().selected }}
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{ cursor: "pointer", ...props.style }}
        >
          {props.children}
        </View>
      }
    >
      <MenuItem
        disabled={props.disabled}
        role={props.role ?? "menuitem"}
        checked={props.checked}
        accessibilityLabel={props.label}
        accessibilityDescription={props.description}
        style={props.style}
        hoverStyle={hover}
        indicatorStyle={{ width: 0 }}
        onSelect={props.onSelect}
      >
        {props.children}
      </MenuItem>
    </If>
  );
}

/** A rule between a `MenuFrame`'s groups. */
export function MenuRule(props: { style: ViewStyle }) {
  return (
    <If when={MenuHost().native} else={<View style={props.style} />}>
      <MenuSeparator style={props.style} />
    </If>
  );
}
