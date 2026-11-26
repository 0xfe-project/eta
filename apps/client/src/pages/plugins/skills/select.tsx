import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../../components";
import {
  canHover,
  inSheet,
  touchRow,
  touchScreen,
} from "../../../components/menu";
import { LayoutSelect } from "../../../components/select";
import { control, icon, shadow, space } from "../../../components/tokens";

/**
 * The skills page's device and project pickers: the design's select menu, as
 * wide as its trigger, with 28pt rows, a muted fill and a check on the chosen
 * one, and a muted suffix after a title (the primary device's).
 */
export function SkillSelect(props: {
  label: string;
  items: { value: string; title: string; suffix?: string }[];
  value: string | undefined;
  placeholder: string;
  triggerStyle?: ViewStyle;
  onChange: (value: string) => void;
}) {
  const c = colors();
  const current = () => props.items.find((item) => item.value === props.value);
  return (
    <LayoutSelect
      accessibilityLabel={props.label}
      items={props.items.map((item) => ({
        value: item.value,
        title: item.suffix ? `${item.title} ${item.suffix}` : item.title,
      }))}
      value={props.value ?? null}
      placeholder={props.placeholder}
      cover={false}
      offset={3}
      popupStyle={{
        padding: space[4],
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        boxShadow: [shadow.popover],
      }}
      itemStyle={{ minHeight: control.md, paddingHorizontal: 0 }}
      renderItem={(entry) => {
        const item = props.items.find((option) => option.value === entry.value);
        const chosen = () => entry.value === props.value;
        return (
          <View
            hoverStyle={
              !inSheet() && canHover
                ? { backgroundColor: c().selected }
                : undefined
            }
            style={{
              ...row,
              flex: 1,
              gap: inSheet() ? space[12] : space[8],
              minHeight: inSheet()
                ? undefined
                : touchScreen
                  ? touchRow
                  : undefined,
              height: inSheet() || touchScreen ? undefined : control.md,
              paddingHorizontal: inSheet() ? 0 : space[8],
              backgroundColor:
                !inSheet() && chosen() ? c().selected : undefined,
            }}
          >
            <View style={{ ...row, flex: 1, minWidth: 0, gap: space[4] }}>
              <Label variant="small" lines={1} style={{ flexShrink: 1 }}>
                {item?.title ?? entry.title}
              </Label>
              <If when={item?.suffix}>
                <Label variant="small" tone="muted" lines={1}>
                  {item?.suffix ?? ""}
                </Label>
              </If>
            </View>
            <View style={{ width: icon.md, flexShrink: 0 }}>
              <If when={chosen()}>
                <Icon name="check" size={icon.md} />
              </If>
            </View>
          </View>
        );
      }}
      trigger={
        <View
          hoverStyle={canHover ? { backgroundColor: c().selected } : undefined}
          style={{
            ...row,
            justifyContent: "space-between",
            gap: space[8],
            height: control.md,
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            cursor: "pointer",
            ...props.triggerStyle,
          }}
        >
          <Label
            variant="small"
            lines={1}
            tone={current() ? "ink" : "muted"}
            style={{ flex: 1, minWidth: 0 }}
          >
            {current()?.title ?? props.placeholder}
          </Label>
          <Icon name="down" size={icon.sm} tone="muted" />
        </View>
      }
      onChange={({ value }) => {
        if (value !== null && value !== props.value) props.onChange(value);
      }}
    />
  );
}
