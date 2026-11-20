import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { Select } from "nsh/base";
import { colors, Icon, Label, row } from "../../../components";

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
    <Select
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
        padding: 4,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        boxShadow: [{ x: 0, y: 8, blur: 24, color: "#0000001f" }],
      }}
      itemStyle={{ minHeight: 28, paddingHorizontal: 0 }}
      renderItem={(entry) => {
        const item = props.items.find((option) => option.value === entry.value);
        const chosen = () => entry.value === props.value;
        return (
          <View
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              flex: 1,
              gap: 8,
              height: 28,
              paddingHorizontal: 8,
              backgroundColor: chosen() ? c().selected : undefined,
            }}
          >
            <View style={{ ...row, flex: 1, minWidth: 0, gap: 6 }}>
              <Label size={12} line={16} lines={1} style={{ flexShrink: 1 }}>
                {item?.title ?? entry.title}
              </Label>
              <If when={item?.suffix}>
                <Label size={12} line={16} tone="muted" lines={1}>
                  {item?.suffix ?? ""}
                </Label>
              </If>
            </View>
            <View style={{ width: 14, flexShrink: 0 }}>
              <If when={chosen()}>
                <Icon name="check" size={14} />
              </If>
            </View>
          </View>
        );
      }}
      trigger={
        <View
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            justifyContent: "space-between",
            gap: 8,
            height: 28,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            cursor: "pointer",
            ...props.triggerStyle,
          }}
        >
          <Label
            size={12}
            line={16}
            lines={1}
            tone={current() ? "ink" : "muted"}
            style={{ flex: 1, minWidth: 0 }}
          >
            {current()?.title ?? props.placeholder}
          </Label>
          <Icon name="down" size={10} tone="muted" />
        </View>
      }
      onChange={({ value }) => {
        if (value !== null && value !== props.value) props.onChange(value);
      }}
    />
  );
}
