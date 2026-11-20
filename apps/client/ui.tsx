import type { JSX, TextStyle, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import {
  cleanup,
  context,
  Image,
  keymap,
  Overlay,
  platform,
  safeAreaInsets,
  Text,
  View,
} from "nsh";
import { Dialog, Input, Menu, MenuItem, TextView } from "nsh/base";
import inter from "./assets/InterVariable.woff2";
import { pickerTarget } from "./element-picker";
import { iconPaths } from "./icons";
import { useText } from "./locale";

const light = {
  canvas: "#ffffff",
  surface: "#fafafa",
  selected: "#f2f2f2",
  ink: "#111111",
  muted: "#6e6e6e",
  mutedInk: "#505050",
  faint: "#8c8c8c",
  border: "#e5e5e5",
  strong: "#cccccc",
  button: "#171717",
  buttonInk: "#ffffff",
  blue: "#006cb5",
  blueFill: "#e0eff8",
  green: "#008035",
  greenFill: "#e8f2eb",
  amber: "#a46700",
  amberFill: "#f7efdf",
  red: "#c61623",
  redFill: "#fce9eb",
  shade: "#00000020",
  modalShade: "#0000001e",
};

const dark: typeof light = {
  canvas: "#0a0a0a",
  surface: "#090909",
  selected: "#232323",
  ink: "#fafafa",
  muted: "#a3a3a3",
  mutedInk: "#c5c5c5",
  faint: "#777777",
  border: "#292929",
  strong: "#4a4a4a",
  button: "#f5f5f5",
  buttonInk: "#101010",
  blue: "#65b7f0",
  blueFill: "#132a3b",
  green: "#52bb81",
  greenFill: "#16291e",
  amber: "#e0aa53",
  amberFill: "#302618",
  red: "#ff6874",
  redFill: "#3a1d21",
  shade: "#00000080",
  modalShade: "#00000048",
};

export const Palette = context<() => typeof light>(() => light);
export const palette = (mode: "light" | "dark") =>
  mode === "dark" ? dark : light;
export function colors() {
  return Palette();
}
export const row: ViewStyle = { flexDirection: "row", alignItems: "center" };
export const grow: ViewStyle = { flex: 1, minWidth: 0, minHeight: 0 };
export const fill: ViewStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};
const defaultFont = `${inter}, system-ui, sans-serif`;
export const Fonts = context<() => { interface: string; mono: string }>(() => ({
  interface: "",
  mono: "",
}));
export function fontFamily(family: string, fallback = defaultFont) {
  if (!family.trim()) return fallback;
  return `${JSON.stringify(family.trim())}, ${fallback}`;
}
export const sizes = {
  sidebar: 288,
  tabletList: 320,
  rail: 64,
  panel: 400,
  header: 40,
  phoneNav: 64,
};
export type Layout = "desktop" | "tablet" | "phone";

export function Label(props: {
  children?: JSX.Element | string | number;
  size?: number;
  line?: number;
  tone?: keyof typeof light;
  weight?: number;
  lines?: number;
  style?: TextStyle;
}) {
  const color = colors();
  const fonts = Fonts();
  return (
    <Text
      style={{
        fontFamily: fontFamily(fonts().interface),
        fontSize: props.size ?? 14,
        lineHeight: props.line ?? (props.size ?? 14) + 6,
        fontWeight: props.weight ?? 400,
        color: color()[props.tone ?? "ink"],
        numberOfLines: props.lines,
        ...props.style,
      }}
    >
      {props.children}
    </Text>
  );
}

export function Icon(props: {
  name: IconName;
  size?: number;
  tone?: keyof typeof light;
}) {
  const color = colors();
  const src = () =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="${
        color()[props.tone ?? "ink"]
      }" d="${iconPaths[props.name]}"/></svg>`,
    )}`;
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{
        width: props.size ?? 14,
        height: props.size ?? 14,
        flexShrink: 0,
      }}
    />
  );
}

export function Button(props: {
  label: string;
  icon?: IconName;
  end?: IconName;
  iconOnly?: boolean;
  tone?: "primary" | "plain" | "ghost" | "danger";
  selected?: boolean;
  disabled?: boolean;
  size?: number;
  labelSize?: number;
  dimDisabled?: boolean;
  style?: ViewStyle;
  onPress: () => void;
}) {
  const color = colors();
  const picker = pickerTarget("Button");
  const primary = () => props.tone === "primary";
  const ghost = () => props.tone === "ghost";
  const textTone = () =>
    primary() ? "buttonInk" : props.tone === "danger" ? "red" : "ink";
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{
        disabled: props.disabled ?? false,
        selected: props.selected,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={{
        backgroundColor: primary() ? color().ink : color().selected,
      }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: color().blue,
        outlineOffset: 1,
      }}
      style={{
        ...row,
        justifyContent: "center",
        gap: 5,
        flexShrink: 0,
        height: props.size ?? 24,
        minWidth: props.size ?? 24,
        paddingHorizontal: props.iconOnly ? 3 : 8,
        borderWidth: ghost() ? 0 : 1,
        borderColor: props.selected
          ? color().ink
          : primary()
            ? color().button
            : color().strong,
        backgroundColor: primary()
          ? color().button
          : props.selected
            ? color().selected
            : color().canvas,
        opacity: props.disabled && props.dimDisabled !== false ? 0.45 : 1,
        cursor: props.disabled ? "default" : "pointer",
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon name={props.icon!} tone={textTone()} size={12} />
      </If>
      <If when={!props.iconOnly}>
        <Label
          size={props.labelSize ?? 12}
          line={16}
          weight={props.selected ? 600 : 400}
          tone={textTone()}
        >
          {props.label}
        </Label>
      </If>
      <If when={props.end !== undefined}>
        <Icon
          name={props.end!}
          tone={primary() ? "buttonInk" : "muted"}
          size={10}
        />
      </If>
    </View>
  );
}

export function Field(props: {
  label: string;
  value: string;
  placeholder?: string;
  masked?: boolean;
  maxLength?: number;
  multiline?: boolean;
  style?: TextStyle;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onBlur?: () => void;
}) {
  const color = colors();
  const fonts = Fonts();
  const picker = pickerTarget("Field", "apps/client/ui.tsx", false);
  return (
    <Input
      ref={picker.ref}
      onMouseEnter={picker.onMouseEnter}
      onMouseLeave={picker.onMouseLeave}
      accessibilityLabel={props.label}
      value={props.value}
      placeholder={props.placeholder}
      masked={props.masked}
      maxLength={props.maxLength}
      multiline={props.multiline}
      submitBehavior={
        props.onSubmit
          ? "submit"
          : props.multiline
            ? "newline"
            : "blurAndSubmit"
      }
      onChange={({ value }) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      onBlur={props.onBlur}
      focusStyle={{ borderColor: color().ink }}
      style={{
        color: color().ink,
        placeholderColor: color().muted,
        backgroundColor: color().canvas,
        fontFamily: fontFamily(fonts().interface),
        fontSize: 14,
        lineHeight: 20,
        height: 32,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: color().border,
        borderRadius: 0,
        ...props.style,
      }}
    />
  );
}

export function Markdown(props: {
  value: string;
  line?: number;
  streaming?: boolean;
  compactHeadings?: boolean;
}) {
  const c = colors();
  const fonts = Fonts();
  const code = () =>
    fonts().mono
      ? { fontFamily: fontFamily(fonts().mono, "monospace") }
      : undefined;
  const heading = {
    fontSize: 15,
    lineHeight: 20,
    marginTop: 16,
    marginBottom: 6,
  };
  return (
    <TextView
      markdown={props.value}
      options={{ html: false, streaming: props.streaming }}
      selectable
      links="open"
      styles={{
        root: {
          fontFamily: fontFamily(fonts().interface),
          fontSize: 14,
          lineHeight: props.line ?? 24,
          color: c().ink,
        },
        paragraph: { marginTop: 0, marginBottom: 0 },
        codeBlock: code(),
        code: code(),
        heading1: props.compactHeadings ? heading : undefined,
        heading2: props.compactHeadings ? heading : undefined,
        heading3: props.compactHeadings ? heading : undefined,
        link: { color: c().blue },
      }}
      codeBlockActions={[{ id: "copy" }]}
    />
  );
}

export function Caption(props: { text: string; style?: TextStyle }) {
  return (
    <Label
      size={10}
      line={14}
      tone="muted"
      style={{ letterSpacing: 1.2, textTransform: "uppercase", ...props.style }}
    >
      {props.text}
    </Label>
  );
}

export function Empty(props: {
  title: string;
  description?: string;
  icon?: IconName;
  children?: JSX.Element;
  style?: ViewStyle;
}) {
  return (
    <View
      style={{
        ...grow,
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 24,
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon name={props.icon!} size={20} tone="muted" />
      </If>
      <Label
        weight={props.description ? 500 : 400}
        tone={props.description ? "ink" : "muted"}
        style={{ textAlign: "center" }}
      >
        {props.title}
      </Label>
      <If when={props.description !== undefined}>
        <Label
          tone="muted"
          size={12}
          style={{ textAlign: "center", maxWidth: 300 }}
        >
          {props.description}
        </Label>
      </If>
      {props.children}
    </View>
  );
}

export function ActionMenu(props: {
  label: string;
  value?: string;
  truncateValue?: boolean;
  triggerStyle?: ViewStyle;
  children?: JSX.Element;
}) {
  const c = colors();
  const picker = pickerTarget("ActionMenu");
  return (
    <Menu
      placement="bottom"
      align="end"
      offset={3}
      popupStyle={{
        width: 172,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={
        <View
          {...picker}
          accessibilityLabel={props.label}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            justifyContent: props.value ? "space-between" : "center",
            minWidth: 32,
            height: 30,
            paddingHorizontal: 7,
            gap: 7,
            cursor: "pointer",
            borderWidth: props.value ? 1 : 0,
            borderColor: c().strong,
            ...props.triggerStyle,
          }}
        >
          <If when={props.value}>
            <Label
              size={12}
              lines={props.truncateValue ? 1 : undefined}
              style={props.truncateValue ? { flex: 1, minWidth: 0 } : undefined}
            >
              {props.value}
            </Label>
          </If>
          <Icon
            name={props.value ? "down" : "more"}
            size={props.value ? 9 : 17}
          />
        </View>
      }
    >
      {props.children}
    </Menu>
  );
}

export function ActionItem(props: {
  label: string;
  disabled?: boolean;
  checked?: boolean;
  tone?: "red";
  onSelect: () => void;
}) {
  const c = colors();
  return (
    <MenuItem
      disabled={props.disabled}
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      checked={props.checked}
      accessibilityLabel={props.label}
      style={{ ...row, minHeight: 33, paddingHorizontal: 9, gap: 6 }}
      hoverStyle={{ backgroundColor: c().selected }}
      indicatorStyle={{ width: 0 }}
      onSelect={props.onSelect}
    >
      <Label size={12} tone={props.tone} style={{ flex: 1 }}>
        {props.label}
      </Label>
      <If when={props.checked}>
        <Icon name="check" size={12} />
      </If>
    </MenuItem>
  );
}

export function Header(props: {
  title: string;
  count?: number;
  subtitle?: string;
  subtitleTone?: "green" | "amber" | "muted";
  layout?: Layout;
  inset?: number;
  dialog?: boolean;
  children?: JSX.Element;
  onBack?: () => void;
}) {
  const color = colors();
  const text = useText();
  const picker = pickerTarget("Header");
  return (
    <View
      {...picker}
      web={{ element: "header" }}
      style={{
        ...row,
        flexShrink: 0,
        height: props.layout === "phone" ? 46 : sizes.header,
        paddingHorizontal: props.inset ?? (props.layout === "phone" ? 16 : 22),
        borderBottomWidth: 1,
        borderColor: color().border,
        backgroundColor:
          props.layout === "phone" || props.dialog
            ? color().canvas
            : color().surface,
        gap: 8,
        zIndex: 1,
      }}
    >
      <If when={props.onBack !== undefined}>
        <Button
          label={text("back")}
          icon="back"
          iconOnly
          tone="ghost"
          onPress={() => props.onBack?.()}
        />
      </If>
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Label
          weight={props.dialog ? 500 : 600}
          size={props.layout === "phone" || props.dialog ? 16 : 14}
          line={props.subtitle ? 18 : undefined}
          lines={1}
        >
          {props.title}
        </Label>
        <If when={props.subtitle}>
          <View style={{ ...row, gap: 6 }}>
            <If when={props.subtitleTone}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  backgroundColor: color()[props.subtitleTone ?? "muted"],
                }}
              />
            </If>
            <Label size={11} line={15} tone="muted" lines={1}>
              {props.subtitle}
            </Label>
          </View>
        </If>
      </View>
      <If when={props.count !== undefined}>
        <Label size={12} tone="muted">
          {props.count}
        </Label>
      </If>
      <If when={props.inset === undefined}>
        <View style={{ flex: 1 }} />
      </If>
      {props.children}
    </View>
  );
}

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
  const text = useText();
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
    borderWidth: props.sheet || props.phonePage ? 0 : 1,
    borderTopWidth: props.phonePage ? 0 : 1,
    borderColor: props.sheet ? color().border : color().strong,
    overflow: "hidden",
    ...props.panelStyle,
  });
  const backdropStyle = (): ViewStyle => {
    const blur =
      !props.sheet && !props.phonePage && props.blurBackdrop !== false;
    const usesSystemMaterial = platform.os === "macos" || platform.os === "ios";
    return {
      backgroundColor: props.phonePage ? color().canvas : color().modalShade,
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
              height: 13,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <View
              style={{ width: 36, height: 4, backgroundColor: color().border }}
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
              <Button
                label={text("close")}
                icon="close"
                iconOnly
                tone="ghost"
                onPress={close}
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
