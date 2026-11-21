import type { TextStyle, ViewStyle } from "nsh";
import type { SelectProps } from "nsh/base";
import { View } from "nsh";
import { Select } from "nsh/base";
import {
  inSheet,
  menuEngine,
  MenuFrame,
  menuPresentation,
  MenuRow,
  touchRow,
  touchScreen,
} from "./menu";
import { Icon, Label } from "./text";
import { colors, row, Screen } from "./theme";

/**
 * NSH's `Select`, shown as the layout says (`menuPresentation`): a sheet at
 * the bottom in the phone layout, a popup at the trigger in the tablet and
 * desktop layouts, whatever the platform. NSH's `Select` chooses by platform
 * (a popup on the desktops, a sheet on phones and tablets), so it draws the
 * list only where that is what the layout asks; elsewhere (a tablet's touch
 * screen, a narrow desktop window) the list is a `MenuFrame` of the same
 * items, one row each, without search or typeahead.
 */
export function LayoutSelect(
  props: SelectProps & {
    accessibilityLabel: string;
    /** The width of the list as a popup of rows (NSH's is as wide as the trigger). */
    menuWidth?: number;
  },
) {
  const c = colors();
  const layout = Screen();
  const native = () => menuEngine(menuPresentation(layout())) === "menu";
  const items = () => props.items ?? [];
  const itemStyle = () => (props.itemStyle ?? {}) as TextStyle;
  const choose = (value: string) => props.onChange?.({ value });
  return (
    <If
      when={native()}
      else={
        <MenuFrame
          disabled={props.disabled}
          align={props.align === "end" ? "end" : "start"}
          offset={props.offset}
          popupStyle={{
            width: props.menuWidth ?? 220,
            ...(props.popupStyle as ViewStyle | undefined),
          }}
          trigger={
            // NSH's Select names its trigger; the trigger here says the same.
            <View
              accessibilityLabel={props.accessibilityLabel}
              accessibilityValue={{
                text: items().find((item) => item.value === props.value)?.title,
              }}
            >
              {props.trigger}
            </View>
          }
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
                    gap: 8,
                    minHeight: inSheet()
                      ? 52
                      : touchScreen
                        ? touchRow
                        : (itemStyle().minHeight ?? 28),
                    paddingHorizontal: inSheet()
                      ? 16
                      : (itemStyle().paddingHorizontal ?? 8),
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
                        <View style={{ width: 12, flexShrink: 0 }}>
                          <If when={chosen()}>
                            <Icon name="check" size={12} />
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
        </MenuFrame>
      }
    >
      <Select {...props} />
    </If>
  );
}
