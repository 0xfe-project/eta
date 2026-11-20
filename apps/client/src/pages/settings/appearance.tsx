import type { JSX } from "nsh";
import { effect, Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Field,
  Fonts,
  grow,
  Label,
  row,
} from "../../components";
import { ElementPicking, pickerTarget } from "../../components/element-picker";
import { ToggleSwitch } from "../../components/toggle-switch";
import { languageChoices, LanguageSettings, useText } from "../../i18n";

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

export interface AppearanceProps {
  theme: Theme;
  onTheme: (mode: Theme) => void;
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
        ...(props.stack ? { gap: 8 } : { ...row, gap: props.phone ? 24 : 16 }),
        minHeight: props.phone ? 44 : 40,
        paddingHorizontal: 16,
        paddingVertical: 8,
        flexShrink: 0,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={props.stack ? undefined : { flex: 1, minWidth: 0, gap: 2 }}>
        <Label line={20}>{props.title}</Label>
        <If when={props.error}>
          <Label size={12} line={16} tone="red">
            {props.error}
          </Label>
        </If>
        <If when={!props.error && props.hint}>
          <Label size={12} line={16} tone="muted">
            {props.hint}
          </Label>
        </If>
      </View>
      {props.children}
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
  set: (choice: T) => void;
}) {
  return (
    <AppearanceRow
      title={props.title}
      hint={props.phone ? undefined : props.hint}
      phone={props.phone}
      stack={props.phone}
    >
      <ActionMenu
        label={props.title}
        value={props.displayValue ?? props.name(props.value)}
        triggerStyle={{
          width: props.phone ? "100%" : 160,
          height: props.phone ? 32 : 24,
          paddingLeft: props.phone ? 12 : 10,
          paddingRight: props.phone ? 12 : 8,
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
          width: props.phone ? "100%" : 200,
          height: props.phone ? 32 : 24,
          fontSize: 12,
          lineHeight: 16,
          paddingHorizontal: props.phone ? 12 : 10,
          paddingVertical: 2,
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
  return (
    <Scroll style={grow} scrollbar={false}>
      <ChoiceRow
        title={text("colorMode")}
        phone={props.phone}
        choices={["system", "light", "dark"] as const}
        value={props.theme}
        name={(mode) => text(themeLabels[mode])}
        set={props.onTheme}
      />
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
    </Scroll>
  );
}
