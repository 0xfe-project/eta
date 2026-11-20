import type { JSX, ViewStyle } from "nsh";
import { cleanup, keymap, Overlay, platform, safeAreaInsets, View } from "nsh";
import { Dialog } from "nsh/base";
import { Header } from "./header";
import { CloseButton } from "./navigation-buttons";
import { colors, fill } from "./theme";

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
  const insets = safeAreaInsets();
  const focused = props.modalFocus && !props.phone;
  const popupStyle = (): ViewStyle => ({
    width: props.phone ? "100%" : (props.width ?? 480),
    maxWidth: "100%",
    maxHeight: "100%",
    height: props.height,
    backgroundColor: color().canvas,
    borderWidth: props.phonePage ? 0 : 1,
    borderColor: color().strong,
    overflow: "hidden",
    ...props.panelStyle,
  });
  const backdropStyle = (): ViewStyle => {
    const blur =
      !props.sheet && !props.phonePage && props.blurBackdrop !== false;
    const usesSystemMaterial = platform.os === "macos" || platform.os === "ios";
    return {
      backgroundColor: props.phonePage
        ? color().canvas
        : props.sheet
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
              height: 16,
              paddingTop: 8,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <View
              style={{ width: 36, height: 4, backgroundColor: color().strong }}
            />
          </View>
        </If>
        <If when={!props.hideHeader}>
          <Header
            title={props.title}
            subtitle={props.subtitle}
            subtitleTone={props.subtitleTone}
            layout={props.phone ? "phone" : "desktop"}
            inset={12}
            dialog={!props.phonePage}
            onBack={props.phonePage ? close : undefined}
          >
            <View style={{ flex: 1 }} />
            {props.headerActions}
            <If when={props.dismissible !== false && !props.phonePage}>
              <CloseButton onPress={close} />
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
  const dialog = () => (
    <View
      style={{
        ...fill,
        paddingTop: props.phone && props.overPhoneNavigation ? insets().top : 0,
        paddingBottom:
          props.phone && props.overPhoneNavigation ? insets().bottom : 0,
        paddingLeft:
          props.phone && props.overPhoneNavigation ? insets().left : 0,
        paddingRight:
          props.phone && props.overPhoneNavigation ? insets().right : 0,
        zIndex: 100,
        alignItems: props.side ? "flex-end" : "center",
        justifyContent: props.phone ? "flex-end" : "center",
      }}
    >
      {panel()}
    </View>
  );
  return (
    <Each of={[Boolean(props.overPhoneNavigation)]}>
      {(overlay) =>
        overlay() ? <Overlay style={fill}>{dialog()}</Overlay> : dialog()
      }
    </Each>
  );
}
