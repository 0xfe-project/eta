import type { JSX, ViewStyle } from "nsh";
import type { DialogProps } from "nsh/base";
import {
  cleanup,
  computed,
  Overlay,
  platform,
  signal,
  View,
  windowSize,
} from "nsh";
import { Dialog } from "nsh/base";
import { Regular } from "../components/density";
import { fade, fadeIn, fadeOut, motion, passing } from "../components/motion";
import {
  NotificationDepth,
  NotificationHost,
} from "../components/notifications";
import { screenInsets } from "../components/safe-area";
import { colors, fill, row } from "../components/theme";
import {
  control,
  icon,
  layer,
  shadow,
  space,
  weight,
} from "../components/tokens";
import { createDismissable } from "./behaviors";
import { CloseButton } from "./button";
import { Header } from "./header";
import { Label } from "./text";

/** A centred dialog's width: `sm` a confirmation, `md` a short form (the default), `lg` a form
 * with rows, `xl` a dialog with its own layout. Not tokens: only a dialog takes them. */
export const dialogWidth = { sm: 360, md: 448, lg: 560, xl: 640 } as const;

/** The grabber atop a phone sheet. */
const grabberWidth = 36;

/** The header bar: a phone sheet's (44 with no divider under it), a stepped dialog's. */
const headerHeight = { sheet: 40, plainSheet: 44, step: 48 } as const;

/**
 * Shared native `<Dialog>` primitive that mounts the unified `NotificationHost` inside its native
 * top-level layer so Toasts, Progress Notifications, and Host Error alerts stay above its backdrop.
 */
export function NativeDialog(
  props: DialogProps & { leaving?: boolean; phone?: boolean },
) {
  const parentDepth = NotificationDepth();
  const depth = () => parentDepth() + 1;
  // Memoize children so sibling NotificationHost overlay updates never re-evaluate or remount the dialog body.
  const content = computed(() => props.children);
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation={props.animation}
      presentation={props.presentation}
      closeOnEscape={props.closeOnEscape}
      closeOnBackdropPress={props.closeOnBackdropPress}
      closeOnSwipe={props.closeOnSwipe}
      detents={props.detents}
      detent={props.detent}
      defaultDetent={props.defaultDetent}
      grabber={props.grabber}
      largestUndimmedDetent={props.largestUndimmedDetent}
      onDetentChange={props.onDetentChange}
      transitionShader={props.transitionShader}
      statusBar={props.statusBar}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityDescription={props.accessibilityDescription}
      role={props.role}
      onOpen={props.onOpen}
      onClose={props.onClose}
      onCancel={props.onCancel}
      onOpenChange={props.onOpenChange}
      style={props.style}
      class={props.class}
      backdropStyle={props.backdropStyle}
      backdropClass={props.backdropClass}
      backdropTestID={props.backdropTestID}
      ios={props.ios}
      android={props.android}
    >
      <NotificationDepth.Provider value={depth}>
        {content()}
      </NotificationDepth.Provider>
      <NotificationHost
        active={props.open !== false && !props.leaving}
        phone={props.phone}
        depth={depth()}
      />
    </Dialog>
  );
}

export function Modal(props: {
  title: string;
  subtitle?: string;
  subtitleTone?: "green" | "warning" | "muted";
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
  const from =
    props.phonePage || (props.side && !props.phone) ? "end" : "below";
  const pace = props.phone ? "phone" : "window";
  const shade = passing();
  const lift = passing();
  void shade.play(fade(1, motion.dialogIn[pace]));
  void lift.play(fadeIn(from, motion.dialogIn[pace]));
  const leaving = signal(false);
  let gone = false;
  cleanup(() => {
    gone = true;
  });
  const close = () => {
    if (props.dismissible === false || leaving()) return;
    leaving.set(true);
    void Promise.all([
      shade.play(fade(0, motion.dialogOut[pace])),
      lift.play(fadeOut(from, motion.dialogOut[pace])),
    ]).then(() => {
      if (!gone) props.onClose();
    });
  };
  createDismissable({
    onDismiss: close,
    enabled: () => props.dismissible !== false && !leaving(),
  });
  const insets = screenInsets();
  const focused = props.modalFocus && !props.phone;
  const tablet = () => !props.phone && windowSize().width < 1200;
  const sheetChrome = () => Boolean(props.phone) && !props.phonePage;
  const sideDrawer = () => Boolean(props.side) && !props.phone;
  const centred = () => !props.phone && !props.side;
  const stepHeader = () => Boolean(props.stepHeader) && centred();
  const popupStyle = (): ViewStyle => ({
    width: props.phone ? "100%" : (props.width ?? dialogWidth.md),
    maxWidth: "100%",
    maxHeight: "100%",
    height: props.height,
    backgroundColor: color().canvas,
    borderWidth: props.phonePage || sideDrawer() ? 0 : 1,
    borderLeftWidth: props.phonePage ? 0 : 1,
    borderColor: color().strong,
    overflow: "hidden",
    boxShadow: centred() ? [shadow.popover] : undefined,
    ...(props.compact ? { padding: space[16] } : {}),
    ...props.panelStyle,
    ...lift.style(),
    pointerEvents: leaving() ? "none" : "auto",
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
          ? color().sheetScrim
          : color().scrim,
      backdropFilter: blur ? "blur(3px)" : undefined,
      maskImage:
        blur && usesSystemMaterial
          ? "linear-gradient(black, black)"
          : undefined,
    };
  };
  const panel = () => (
    <Regular>
      <View
        style={{
          ...fill,
          ...backdropStyle(),
          ...shade.style(),
          pointerEvents: leaving() ? "none" : "auto",
        }}
        onPress={props.dismissible === false ? undefined : close}
      />
      <View role="dialog" accessibilityLabel={props.title} style={popupStyle()}>
        <If when={props.sheet}>
          <View
            style={{
              height: props.plainSheetHeader ? space[16] : space[20],
              paddingTop: props.plainSheetHeader ? space[8] : 0,
              alignItems: "center",
              justifyContent: props.plainSheetHeader ? "flex-start" : "center",
              flexShrink: 0,
            }}
          >
            <View
              style={{
                width: grabberWidth,
                height: space[4],
                backgroundColor: color().strong,
              }}
            />
          </View>
        </If>
        <If when={!props.hideHeader && props.compact}>
          <View style={{ ...row, gap: space[12], flexShrink: 0 }}>
            <Label
              weight={props.titleWeight ?? weight.strong}
              style={{ flex: 1 }}
            >
              {props.title}
            </Label>
            {props.headerActions}
            <If when={props.dismissible !== false}>
              <CloseButton
                onPress={close}
                iconSize={icon.md}
                style={{ marginVertical: -space[4], marginRight: -space[4] }}
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
              sheetChrome()
                ? space[16]
                : sideDrawer()
                  ? space[12]
                  : stepHeader()
                    ? space[20]
                    : space[16]
            }
            end={
              sheetChrome() || sideDrawer() || props.phonePage
                ? space[8]
                : stepHeader()
                  ? space[16]
                  : space[8]
            }
            height={
              sheetChrome()
                ? props.plainSheetHeader
                  ? headerHeight.plainSheet
                  : headerHeight.sheet
                : stepHeader()
                  ? headerHeight.step
                  : undefined
            }
            divider={!(sheetChrome() && props.plainSheetHeader)}
            background={sideDrawer() ? "surface" : undefined}
            titleVariant={
              sheetChrome() || sideDrawer() || stepHeader() ? "body" : undefined
            }
            titleWeight={
              sheetChrome() || sideDrawer() || stepHeader()
                ? weight.strong
                : undefined
            }
            dialog={!props.phonePage}
            onBack={props.phonePage ? close : undefined}
          >
            <View style={{ flex: 1 }} />
            {props.headerActions}
            <If when={props.dismissible !== false && !props.phonePage}>
              <CloseButton
                onPress={close}
                size={sheetChrome() ? control.lg : undefined}
                iconSize={icon.md}
              />
            </If>
          </Header>
        </If>
        {props.children}
      </View>
    </Regular>
  );
  if (focused)
    return (
      <NativeDialog
        accessibilityLabel={props.title}
        style={{ ...fill, alignItems: "center", justifyContent: "center" }}
        animation="none"
        closeOnEscape={false}
        closeOnBackdropPress={false}
        leaving={leaving()}
        phone={props.phone}
        onOpenChange={({ open }) => {
          if (!open) close();
        }}
      >
        {panel()}
      </NativeDialog>
    );
  const dialog = (overlay: boolean) => (
    <View
      style={{
        ...fill,
        paddingTop: overlay ? insets().top : 0,
        paddingBottom: overlay ? insets().bottom : 0,
        paddingLeft: overlay ? insets().left : 0,
        paddingRight: overlay ? insets().right : 0,
        zIndex: layer.modal,
        alignItems: props.side ? "flex-end" : "center",
        justifyContent: props.phone ? "flex-end" : "center",
      }}
    >
      {panel()}
    </View>
  );
  const parentDepth = NotificationDepth();
  const modalDepth = () => parentDepth() + 1;
  return (
    <Each of={[Boolean(props.overPhoneNavigation) || !props.phone]}>
      {(overlay) =>
        overlay() ? (
          <>
            <Overlay style={fill}>
              <NotificationDepth.Provider value={modalDepth}>
                {dialog(true)}
              </NotificationDepth.Provider>
            </Overlay>
            <NotificationHost
              active={!leaving()}
              phone={props.phone}
              depth={modalDepth()}
            />
          </>
        ) : (
          dialog(false)
        )
      }
    </Each>
  );
}
