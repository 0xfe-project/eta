import type { JSX } from "nsh";
import type { Flavor, PaletteId } from "../../components/palettes";
import { colorScheme, effect, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Field,
  Fonts,
  grow,
  Label,
  palette,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { ElementPicking, pickerTarget } from "../../components/element-picker";
import { flavors, paletteIds } from "../../components/palettes";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, space } from "../../components/tokens";
import { languageChoices, LanguageSettings, useText } from "../../i18n";
import { pictureModes, PictureModes } from "../../services/picture-mode";

/** A choice's menu and a typed value, beside their label off phones. */
const menuWidth = 160;
const fieldWidth = 200;

const themeLabels = {
  system: "system",
  light: "light",
  dark: "dark",
} as const;
export type Theme = keyof typeof themeLabels;
const widthLabels = {
  "extra-narrow": "extraNarrow",
  compact: "narrow",
  standard: "standard",
  wide: "full",
} as const;
export type ChatWidth = keyof typeof widthLabels;
const paletteLabels = {
  default: "paletteDefault",
  catppuccin: "paletteCatppuccin",
  dracula: "paletteDracula",
  nord: "paletteNord",
  gruvbox: "paletteGruvbox",
  tokyoNight: "paletteTokyoNight",
  solarized: "paletteSolarized",
  rosePine: "paletteRosePine",
  one: "paletteOne",
} as const;
const flavorNames = {
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
} as const;

export interface AppearanceProps {
  theme: Theme;
  onTheme: (mode: Theme) => void;
  paletteId: PaletteId;
  onPalette: (id: PaletteId) => void;
  flavor: Flavor;
  onFlavor: (flavor: Flavor) => void;
  chatWidth: ChatWidth;
  onChatWidth: (width: ChatWidth) => void;
  chatRail: boolean;
  onChatRail: (on: boolean) => void;
  onFonts: (fonts: { interface: string; mono: string }) => void;
}

function AppearanceRow(props: {
  title: string;
  hint?: string;
  error?: string;
  stack?: boolean;
  phone: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  const picker = pickerTarget(
    "AppearanceRow",
    "apps/client/src/pages/settings/appearance.tsx",
  );
  return (
    <View
      {...picker}
      style={{
        ...(props.stack
          ? { gap: space[8] }
          : { ...row, gap: props.phone ? space[24] : space[16] }),
        minHeight: props.phone ? control.touch : space[40],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        flexShrink: 0,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        style={
          props.stack ? undefined : { flex: 1, minWidth: 0, gap: space[2] }
        }
      >
        <Label>{props.title}</Label>
        <If when={props.error}>
          <Label variant="small" tone="red">
            {props.error}
          </Label>
        </If>
        <If when={!props.error && props.hint}>
          <Label variant="small" tone="muted">
            {props.hint}
          </Label>
        </If>
      </View>
      {props.children}
    </View>
  );
}

/** A palette's ink, accents and canvas as small squares, to choose by sight. */
function Swatches(props: { colors: ReturnType<typeof palette> }) {
  return (
    <View style={{ ...row, gap: space[4] }}>
      <Each
        of={
          [
            props.colors.canvas,
            props.colors.ink,
            props.colors.blue,
            props.colors.green,
            props.colors.warning,
            props.colors.red,
          ] as const
        }
      >
        {(color) => (
          <View
            style={{
              width: space[12],
              height: space[12],
              borderRadius: 2,
              borderWidth: 1,
              borderColor: props.colors.strong,
              backgroundColor: color(),
            }}
          />
        )}
      </Each>
    </View>
  );
}

function ChoiceRow<T extends string>(props: {
  title: string;
  hint?: string;
  phone: boolean;
  choices: readonly T[];
  value: T;
  name: (choice: T) => string;
  displayValue?: string;
  swatches?: ReturnType<typeof palette>;
  set: (choice: T) => void;
}) {
  return (
    <AppearanceRow
      title={props.title}
      hint={props.phone ? undefined : props.hint}
      phone={props.phone}
      stack={props.phone}
    >
      <View style={{ ...row, gap: space[8] }}>
        <If when={props.swatches}>
          {(colors) => <Swatches colors={colors()} />}
        </If>
        <ActionMenu
          label={props.title}
          value={props.displayValue ?? props.name(props.value)}
          triggerStyle={{
            width: props.phone ? "100%" : menuWidth,
            height: props.phone ? space[32] : space[24],
            paddingLeft: space[12],
            paddingRight: props.phone ? space[12] : space[8],
          }}
        >
          <Each of={props.choices}>
            {(option) => (
              <ActionItem
                label={props.name(option())}
                checked={option() === props.value}
                onSelect={() => props.set(option())}
              />
            )}
          </Each>
        </ActionMenu>
      </View>
    </AppearanceRow>
  );
}

function FontRow(props: {
  kind: "interface" | "mono";
  phone: boolean;
  onFonts: AppearanceProps["onFonts"];
}) {
  const text = useText();
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const name = () => fonts()[props.kind];
  const draft = signal(name());
  const invalid = signal(false);
  const mono = () => props.kind === "mono";
  const title = () => text(mono() ? "monoFont" : "interfaceFont");
  effect(() => draft.set(name()));

  function commit() {
    const value = draft().trim();
    if (!/^[\p{L}\p{N}\p{M} ._-]{0,64}$/u.test(value)) {
      invalid.set(true);
      return;
    }
    invalid.set(false);
    draft.set(value);
    if (value !== name()) props.onFonts({ ...fonts(), [props.kind]: value });
  }

  return (
    <AppearanceRow
      title={title()}
      hint={
        props.phone
          ? undefined
          : text(mono() ? "monoFontHint" : "interfaceFontHint")
      }
      error={invalid() ? text("invalidFont") : undefined}
      phone={props.phone}
      stack={props.phone}
    >
      <Field
        label={title()}
        placeholder={mono() ? text("sameAsInterface") : "Eta Sans"}
        value={draft()}
        maxLength={128}
        onChange={(value) => {
          draft.set(value);
          invalid.set(false);
        }}
        onBlur={commit}
        onSubmit={commit}
        style={{
          width: props.phone ? "100%" : fieldWidth,
          height: props.phone ? space[32] : space[24],
          ...textStyle(type("small")),
          paddingHorizontal: space[12],
          paddingVertical: space[2],
          borderColor: invalid() ? c().red : c().strong,
        }}
      />
    </AppearanceRow>
  );
}

function ToggleRow(props: {
  title: string;
  hint?: string;
  checked: boolean;
  phone: boolean;
  set: (checked: boolean) => void;
}) {
  return (
    <AppearanceRow title={props.title} hint={props.hint} phone={props.phone}>
      <ToggleSwitch
        label={props.title}
        checked={props.checked}
        onChange={props.set}
      />
    </AppearanceRow>
  );
}

export function Appearance(props: AppearanceProps & { phone: boolean }) {
  const text = useText();
  const language = LanguageSettings();
  const picker = ElementPicking();
  const pictures = PictureModes();
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <ChoiceRow
        title={text("colorMode")}
        phone={props.phone}
        choices={["system", "light", "dark"] as const}
        value={props.theme}
        name={(mode) => text(themeLabels[mode])}
        set={props.onTheme}
      />
      <ChoiceRow
        title={text("palette")}
        phone={props.phone}
        choices={paletteIds}
        value={props.paletteId}
        name={(id) => text(paletteLabels[id])}
        swatches={palette(colorScheme(), props.paletteId, props.flavor)}
        set={props.onPalette}
      />
      <If when={props.paletteId === "catppuccin"}>
        <ChoiceRow
          title={text("flavor")}
          hint={text("flavorHint")}
          phone={props.phone}
          choices={flavors}
          value={props.flavor}
          name={(name) => flavorNames[name]}
          swatches={palette("dark", props.paletteId, props.flavor)}
          set={props.onFlavor}
        />
      </If>
      <If when={language}>
        {(setting) => (
          <ChoiceRow
            title={text("language")}
            phone={props.phone}
            choices={languageChoices}
            value={setting().preference()}
            name={(choice) =>
              choice === "system"
                ? text("languageSystem")
                : choice === "zh"
                  ? "简体中文"
                  : "English"
            }
            displayValue={
              setting().language() === "en" ? "English" : "简体中文"
            }
            set={setting().set}
          />
        )}
      </If>
      <ChoiceRow
        title={text("chatWidth")}
        hint={text("chatWidthHint")}
        phone={props.phone}
        choices={["extra-narrow", "compact", "standard", "wide"] as const}
        value={props.chatWidth}
        name={(width) => text(widthLabels[width])}
        set={props.onChatWidth}
      />
      <ChoiceRow
        title={text("picturesInMessages")}
        hint={text("picturesInMessagesHint")}
        phone={props.phone}
        choices={pictureModes}
        value={pictures.mode()}
        name={(mode) =>
          text(mode === "compact" ? "picturesCompact" : "picturesExpanded")
        }
        set={pictures.set}
      />
      <FontRow kind="interface" phone={props.phone} onFonts={props.onFonts} />
      <FontRow kind="mono" phone={props.phone} onFonts={props.onFonts} />
      <ToggleRow
        title={text("conversationRail")}
        hint={props.phone ? undefined : text("conversationRailHint")}
        checked={props.chatRail}
        phone={props.phone}
        set={props.onChatRail}
      />
      <If when={picker}>
        {(setting) => (
          <ToggleRow
            title={text("elementPicker")}
            hint={text("elementPickerHint")}
            checked={setting().enabled()}
            phone={props.phone}
            set={setting().set}
          />
        )}
      </If>
    </SmoothScroll>
  );
}
