import type { LlmModel, ProvidersView } from "@eta/client-contracts";
import type { TextStyle, ViewStyle } from "nsh";
import type { SelectProps } from "nsh/base";
import { etaModelThinking } from "@eta/client-contracts";
import { safeArea, signal, View } from "nsh";
import { Select } from "nsh/base";
import {
  canHover,
  inSheet,
  menuEngine,
  MenuFrame,
  menuPresentation,
  MenuRow,
  touchRow,
  touchScreen,
} from "../components/menu";
import { screenInsets } from "../components/safe-area";
import {
  colors,
  focusRing,
  fontFamily,
  Fonts,
  groupHeaderStyle,
  grow,
  row,
  Screen,
  textFaces,
  textStyle,
} from "../components/theme";
import { control, icon, space, weight } from "../components/tokens";
import { uiText, useText } from "../i18n";
import { useHost } from "../services/host";
import { createTypeahead } from "./behaviors";
import { Button } from "./button";
import { Icon, Label } from "./text";

/** The menu of a select on a desktop, unless its caller says. */
const menuWidth = 220;
/** A choice's row in a phone sheet. */
const sheetRowHeight = 52;
/** How much of the screen a phone's select sheet may take. */
const sheetMaxHeight = "80%";

/** The model picker's popup: wide enough for a provider's long model ids. */
const popupWidth = 336;
const popupHeight = 312;
const searchHeight = 36;

/**
 * NSH's `Select`, shown as the layout says (`menuPresentation`): a sheet at
 * the bottom in the phone layout, a popup at the trigger in the tablet and
 * desktop layouts, whatever the platform. NSH's `Select` chooses by platform
 * (a popup on the desktops, a sheet on phones and tablets), so it draws the
 * list only for desktop popups; on every phone layout (including iOS and
 * Android) and touch-tablet popups, `MenuFrame` draws the styled sheet or
 * popover with keyboard typeahead via `createTypeahead`.
 */
export function LayoutSelect(
  props: SelectProps & {
    accessibilityLabel: string;
    /** The width of the list as a popup of rows (NSH's is as wide as the trigger). */
    menuWidth?: number;
  },
) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const layout = Screen();
  const presentation = () => menuPresentation(layout());
  const sheet = () => presentation() === "sheet";
  const native = () =>
    presentation() === "popup" && menuEngine("popup") === "menu";
  const text = useText();
  const open = signal(false);
  const titled = () => sheet() && !!props.accessibilityLabel;
  const items = () => props.items ?? [];
  const itemStyle = () => (props.itemStyle ?? {}) as TextStyle;
  const choose = (value: string) => props.onChange?.({ value });
  const typeahead = createTypeahead({
    items: () =>
      items().map((item) => ({
        id: item.value,
        label: item.title,
        disabled: item.disabled,
      })),
    activeId: () => props.value ?? undefined,
    onMatch: choose,
  });
  return (
    <If
      when={native()}
      else={
        <MenuFrame
          disabled={props.disabled}
          align={props.align === "end" ? "end" : "start"}
          offset={props.offset}
          open={props.open ?? (titled() ? open() : undefined)}
          onOpenChange={(next) => {
            open.set(next);
            props.onOpenChange?.({
              open: next,
              reason: next ? "triggerPress" : "cancel",
            });
          }}
          popupStyle={{
            width: props.menuWidth ?? menuWidth,
            ...(props.popupStyle as ViewStyle | undefined),
          }}
          sheetHeader={
            <If when={props.accessibilityLabel}>
              <View
                testID="select-sheet-header"
                style={{
                  ...row,
                  height: control.touch,
                  paddingLeft: space[16],
                  paddingRight: space[8],
                }}
              >
                <Label weight={weight.strong} lines={1} style={grow}>
                  {props.accessibilityLabel}
                </Label>
                <Button
                  label={text("close")}
                  icon="close"
                  iconOnly
                  iconSize={icon.md}
                  tone="ghost"
                  size={control.lg}
                  onPress={() => {
                    open.set(false);
                    props.onOpenChange?.({ open: false, reason: "cancel" });
                  }}
                />
              </View>
            </If>
          }
          trigger={
            // NSH's Select names its trigger; the trigger here says the same.
            <View
              accessibilityLabel={props.accessibilityLabel}
              accessibilityValue={{
                text: items().find((item) => item.value === props.value)?.title,
              }}
              focusVisibleStyle={focusRing(c())}
              onKeyDown={(event) => {
                typeahead.onKeyDown(event);
              }}
            >
              {props.trigger}
            </View>
          }
        >
          <View
            onKeyDown={(event) => {
              typeahead.onKeyDown(event);
            }}
          >
            <Each of={items()} key={(item) => item.value}>
              {(item) => {
                const chosen = () => item().value === props.value;
                return (
                  <MenuRow
                    role="menuitemradio"
                    label={item().title}
                    checked={chosen()}
                    disabled={item().disabled}
                    style={{
                      ...row,
                      gap: inSheet() ? space[12] : space[8],
                      minHeight: inSheet()
                        ? sheetRowHeight
                        : touchScreen
                          ? touchRow
                          : (itemStyle().minHeight ?? control.md),
                      paddingHorizontal: inSheet()
                        ? space[16]
                        : (itemStyle().paddingHorizontal ?? space[8]),
                      ...(inSheet()
                        ? { borderTopWidth: 1, borderColor: c().border }
                        : {}),
                      backgroundColor: chosen() ? c().selected : undefined,
                    }}
                    onSelect={() => choose(item().value)}
                  >
                    <If
                      when={props.renderItem}
                      else={
                        <>
                          <Label
                            variant="small"
                            tone={item().disabled ? "muted" : undefined}
                            lines={1}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            {item().title}
                          </Label>
                          <View style={{ width: space[12], flexShrink: 0 }}>
                            <If when={chosen()}>
                              <Icon name="check" size={icon.sm} />
                            </If>
                          </View>
                        </>
                      }
                    >
                      {(render) =>
                        render()({
                          value: item().value,
                          title: item().title,
                          disabled: !!item().disabled,
                          index: items().indexOf(item()),
                          group: item().group,
                        })
                      }
                    </If>
                  </MenuRow>
                );
              }}
            </Each>
          </View>
        </MenuFrame>
      }
    >
      <Select
        {...props}
        groupStyle={{
          ...groupHeaderStyle(type("caption"), fonts(), c()),
          ...(props.groupStyle as TextStyle | undefined),
        }}
      />
    </If>
  );
}

/**
 * The models an eta agent can run on, each with the thinking levels it declares
 * (`etaModelThinking`), so a level picker offers what the model takes.
 */
export function useModels() {
  const host = useHost();
  return () => {
    const configured =
      host.section<ProvidersView>("providers", "config")?.providers ?? [];
    return [
      ...host
        .list<LlmModel>("llm", "models")
        .filter((model) => model.available)
        .map((model) => ({
          id: `llm:${model.id}`,
          name: model.name,
          provider: "Gateway",
          thinking: etaModelThinking(model),
        })),
      ...configured
        .filter((provider) => provider.id !== "llm")
        .flatMap((provider) =>
          provider.models.map((model) => ({
            id: `${provider.id}:${model.id}`,
            name: model.name ?? model.id,
            provider: provider.name,
            thinking: etaModelThinking(model),
          })),
        ),
    ];
  };
}

export function ModelSelect(props: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  /** Drawn as the caller's form draws its other fields, when it has an opinion. */
  triggerStyle?: ViewStyle;
}) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const layout = Screen();
  const phone = () => layout() === "phone";
  const surfaceInsets = screenInsets();
  const bottomInset = () => Math.max(safeArea().bottom, surfaceInsets().bottom);
  const models = useModels();
  const items = () => {
    const all = models().map((model) => ({
      value: model.id,
      title: model.name,
      group: model.provider,
    }));
    if (props.value && !all.some((item) => item.value === props.value))
      all.unshift({
        value: props.value,
        title: props.value,
        group: "Current model",
      });
    return all;
  };
  return (
    <Select
      accessibilityLabel={uiText("model")}
      items={items()}
      value={props.value || null}
      placeholder={props.placeholder ?? uiText("selectModel")}
      searchable
      searchPlaceholder={uiText("searchModels")}
      searchAccessibilityLabel={uiText("searchModels")}
      cover={false}
      offset={2}
      backdropStyle={phone() ? { backgroundColor: c().sheetScrim } : undefined}
      popupStyle={
        phone()
          ? {
              width: "100%",
              borderWidth: 0,
              borderTopWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              maxHeight: sheetMaxHeight,
              paddingBottom: space[8] + bottomInset(),
            }
          : {
              minWidth: popupWidth,
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              maxHeight: popupHeight,
            }
      }
      searchStyle={{
        color: c().ink,
        placeholderColor: c().muted,
        fontFamily: fontFamily(fonts().interface),
        ...textStyle(type("small")),
        paddingHorizontal: phone() ? space[16] : space[12],
        height: phone() ? control.touch : searchHeight,
        backgroundColor: "transparent",
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
      groupStyle={{
        ...groupHeaderStyle(type("caption"), fonts(), c()),
        paddingHorizontal: phone() ? space[16] : space[12],
        paddingTop: space[8],
        paddingBottom: space[4],
      }}
      itemStyle={{
        minHeight: phone()
          ? sheetRowHeight
          : touchScreen
            ? touchRow
            : control.md,
        paddingHorizontal: 0,
        color: c().ink,
        fontFamily: fontFamily(fonts().interface),
        fontSize: type("small").size,
      }}
      empty={
        <View
          style={{
            alignItems: "center",
            paddingVertical: space[24],
            paddingHorizontal: space[12],
          }}
        >
          <Label variant="small" tone="muted">
            {uiText("noModelsMatch")}
          </Label>
        </View>
      }
      renderItem={(item) => (
        <View
          style={{
            ...row,
            flex: 1,
            height: phone()
              ? sheetRowHeight
              : touchScreen
                ? touchRow
                : control.md,
            gap: phone() ? space[12] : space[8],
            paddingHorizontal: phone() ? space[16] : space[12],
            ...(phone() ? { borderTopWidth: 1, borderColor: c().border } : {}),
            backgroundColor:
              item.value === props.value ? c().selected : "transparent",
          }}
        >
          <Label
            variant="small"
            lines={1}
            tone={item.disabled ? "faint" : "ink"}
            style={{ flex: 1 }}
          >
            {item.title}
          </Label>
          <View style={{ width: space[12], height: space[12], flexShrink: 0 }}>
            <If when={item.value === props.value}>
              <Icon name="check" size={icon.sm} />
            </If>
          </View>
        </View>
      )}
      trigger={
        <View
          hoverStyle={canHover ? { borderColor: c().strong } : undefined}
          focusVisibleStyle={focusRing(c())}
          style={{
            ...row,
            height: control.md,
            gap: space[8],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            cursor: "pointer",
            ...props.triggerStyle,
          }}
        >
          <Label variant="small" lines={1} style={{ flex: 1 }}>
            {items().find((item) => item.value === props.value)?.title ??
              props.placeholder ??
              uiText("selectModel")}
          </Label>
          <Icon name="down" size={icon.sm} tone="muted" />
        </View>
      }
      onChange={({ value }) => props.onChange(value ?? "")}
    />
  );
}
