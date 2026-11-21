import type { JSX, ViewStyle } from "nsh";
import { cleanup, keymap, Overlay, platform, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import { Header } from "./header";
import { CloseButton } from "./navigation-buttons";
import { screenInsets } from "./safe-area";
import { Label } from "./text";
import { colors, fill, row } from "./theme";

const modalStack: (() => void)[] = [];

function closeTopModal() {
  modalStack.at(-1)?.();
}

export function Modal(props: {
  title: string;
  subtitle?: string;
  subtitleTone?: "green" | "amber" | "muted";
  width?: number;
  height?: ViewStyle["height"];
  phone?: boolean;
  dismissible?: boolean;
  side?: boolean;
  sheet?: boolean;
  phonePage?: boolean;
  hideHeader?: boolean;
  /** A title row inside the dialog's 14pt padding instead of a header bar. */
  compact?: boolean;
  /** The compact title's weight (600 by default). */
  titleWeight?: number;
  /** A sheet's 44pt header with no divider under it, and a 16pt grabber. */
  plainSheetHeader?: boolean;
  /** The design's stepped-dialog header off phones: 48pt tall, 20pt insets,
   * a 14/18 semibold title and a 16pt close glyph. */
  stepHeader?: boolean;
  headerActions?: JSX.Element;
  blurBackdrop?: boolean;
  modalFocus?: boolean;
  panelStyle?: ViewStyle;
  overPhoneNavigation?: boolean;
  children?: JSX.Element;
  onClose: () => void;
}) {
  const color = colors();
  const close = () => {
    if (props.dismissible !== false) props.onClose();
  };
  modalStack.push(close);
  cleanup(() => {
    const position = modalStack.indexOf(close);
    if (position >= 0) modalStack.splice(position, 1);
  });
  keymap.bind("escape", closeTopModal, { when: "always" });
  // Read here, outside the `Overlay`: the screen's safe area and keyboard.
  const insets = screenInsets();
  const focused = props.modalFocus && !props.phone;
  // The app's tablet width range (App.tsx): dialogs there use the 16% scrim without blur.
  const tablet = () => !props.phone && windowSize().width < 1200;
  const sheetChrome = () => Boolean(props.phone) && !props.phonePage;
  const sideDrawer = () => Boolean(props.side) && !props.phone;
  const centred = () => !props.phone && !props.side;
  const stepHeader = () => Boolean(props.stepHeader) && centred();
  const popupStyle = (): ViewStyle => ({
    width: props.phone ? "100%" : (props.width ?? 480),
    maxWidth: "100%",
    maxHeight: "100%",
    height: props.height,
    backgroundColor: color().canvas,
    borderWidth: props.phonePage || sideDrawer() ? 0 : 1,
    borderLeftWidth: props.phonePage ? 0 : 1,
    borderColor: color().strong,
    overflow: "hidden",
    boxShadow: centred()
      ? [{ x: 0, y: 8, blur: 24, color: "#0000001f" }]
      : undefined,
    ...(props.compact ? { padding: 14 } : {}),
    ...props.panelStyle,
  });
  const backdropStyle = (): ViewStyle => {
    const blur =
      !props.sheet &&
      !props.phonePage &&
      (props.blurBackdrop ?? (centred() && !tablet()));
    const usesSystemMaterial = platform.os === "macos" || platform.os === "ios";
    return {
      backgroundColor: props.phonePage
        ? color().canvas
        : props.phone || props.side || tablet()
          ? color().sheetShade
          : color().modalShade,
      backdropFilter: blur ? "blur(3px)" : undefined,
      // A solid mask keeps Apple's blur while removing the system material tint.
      maskImage:
        blur && usesSystemMaterial
          ? "linear-gradient(black, black)"
          : undefined,
    };
  };
  const panel = () => (
    <>
      <View
        style={{ ...fill, ...backdropStyle() }}
        onPress={props.dismissible === false ? undefined : close}
      />
      <View role="dialog" accessibilityLabel={props.title} style={popupStyle()}>
        <If when={props.sheet}>
          <View
            style={{
              height: props.plainSheetHeader ? 16 : 20,
              paddingTop: props.plainSheetHeader ? 8 : 0,
              alignItems: "center",
              justifyContent: props.plainSheetHeader ? "flex-start" : "center",
              flexShrink: 0,
            }}
          >
            <View
              style={{ width: 36, height: 4, backgroundColor: color().strong }}
            />
          </View>
        </If>
        <If when={!props.hideHeader && props.compact}>
          <View style={{ ...row, gap: 12, flexShrink: 0 }}>
            <Label
              size={14}
              line={20}
              weight={props.titleWeight ?? 600}
              style={{ flex: 1 }}
            >
              {props.title}
            </Label>
            {props.headerActions}
            <If when={props.dismissible !== false}>
              <CloseButton
                onPress={close}
                iconSize={14}
                style={{ marginVertical: -5, marginRight: -5 }}
              />
            </If>
          </View>
        </If>
        <If when={!props.hideHeader && !props.compact}>
          <Header
            title={props.title}
            subtitle={props.subtitle}
            subtitleTone={props.subtitleTone}
            layout={props.phone ? "phone" : "desktop"}
            inset={
              sheetChrome() ? 16 : sideDrawer() ? 12 : stepHeader() ? 20 : 14
            }
            end={
              sheetChrome() || sideDrawer() || props.phonePage
                ? 8
                : stepHeader()
                  ? 16
                  : 6
            }
            height={
              sheetChrome()
                ? props.plainSheetHeader
                  ? 44
                  : 40
                : stepHeader()
                  ? 48
                  : undefined
            }
            divider={!(sheetChrome() && props.plainSheetHeader)}
            background={sideDrawer() ? "surface" : undefined}
            titleSize={
              sheetChrome() || sideDrawer() || stepHeader() ? 14 : undefined
            }
            titleWeight={
              sheetChrome() || sideDrawer() || stepHeader() ? 600 : undefined
            }
            titleLine={
              stepHeader() ? 18 : sheetChrome() || sideDrawer() ? 20 : undefined
            }
            dialog={!props.phonePage}
            onBack={props.phonePage ? close : undefined}
          >
            <View style={{ flex: 1 }} />
            {props.headerActions}
            <If when={props.dismissible !== false && !props.phonePage}>
              <CloseButton
                onPress={close}
                size={sheetChrome() ? 32 : undefined}
                iconSize={sheetChrome() || stepHeader() ? 16 : 14}
              />
            </If>
          </Header>
        </If>
        {props.children}
      </View>
    </>
  );
  if (focused)
    return (
      <Dialog
        accessibilityLabel={props.title}
        style={{ ...fill, alignItems: "center", justifyContent: "center" }}
        animation="none"
        closeOnEscape={false}
        closeOnBackdropPress={false}
        onOpenChange={({ open }) => {
          if (!open) close();
        }}
      >
        {panel()}
      </Dialog>
    );
  // A dialog over the whole screen (an `Overlay`) keeps its panel in the safe
  // part of it and above the keyboard, as the app's root does for the pages;
  // its backdrop, absolute, still covers the system UI. A phone sheet drawn
  // in the page is inside the root's safe area already.
  const dialog = (overlay: boolean) => (
    <View
      style={{
        ...fill,
        paddingTop: overlay ? insets().top : 0,
        paddingBottom: overlay ? insets().bottom : 0,
        paddingLeft: overlay ? insets().left : 0,
        paddingRight: overlay ? insets().right : 0,
        zIndex: 100,
        alignItems: props.side ? "flex-end" : "center",
        justifyContent: props.phone ? "flex-end" : "center",
      }}
    >
      {panel()}
    </View>
  );
  return (
    // Dialogs and drawers cover the whole window (sidebar and rail too); on a
    // phone only those that ask to cover the tab bar do.
    <Each of={[Boolean(props.overPhoneNavigation) || !props.phone]}>
      {(overlay) =>
        overlay() ? (
          <Overlay style={fill}>{dialog(true)}</Overlay>
        ) : (
          dialog(false)
        )
      }
    </Each>
  );
}
