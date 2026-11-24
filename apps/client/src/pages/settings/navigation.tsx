import type { SettingsSection, useSettingsOverview } from "./overview";
import { View } from "nsh";
import { colors, grow, Icon, Label, row, SmoothScroll } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { icon, space } from "../../components/tokens";

import { useText } from "../../i18n";
import { sections } from "./overview";

/** Settings' section list: its column off phones and a row. */
const navWidth = 192;
const navRow = 32;
const phoneNavRow = 48;
export function SettingsNavigation(props: {
  current?: SettingsSection;
  phone: boolean;
  summary: ReturnType<typeof useSettingsOverview>["summary"];
  onSelect: (section: SettingsSection) => void;
}) {
  const c = colors();
  const text = useText();
  // The design writes warnings in the warning ink and errors in muted ink
  // next to a red square: red is only for the mark.
  const summaryTone = (section: SettingsSection) => {
    const tone = props.summary(section).tone;
    return tone === "red" ? "mutedInk" : (tone ?? "muted");
  };
  // Beside a section on a computer it is the page's column in the page's sizes (regular: a 16
  // icon, body text); on a phone it is the page.
  return (
    <SmoothScroll
      style={
        props.phone
          ? grow
          : {
              width: navWidth,
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
            }
      }
      scrollbar={false}
    >
      <View
        style={{
          padding: props.phone ? 0 : space[8],
          gap: props.phone ? 0 : space[2],
        }}
      >
        <Each of={sections}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={text(item()[2])}
              onPress={() => props.onSelect(item()[0])}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: props.phone ? phoneNavRow : navRow,
                paddingHorizontal: props.phone ? space[16] : space[12],
                gap: props.phone ? space[12] : space[8],
                borderBottomWidth: props.phone ? 1 : 0,
                borderColor: c().border,
                backgroundColor:
                  props.current === item()[0] ? c().selected : c().canvas,
                cursor: "pointer",
              }}
            >
              <Icon
                name={item()[1]}
                tone={
                  !props.phone && props.current === item()[0] ? "ink" : "muted"
                }
              />
              <Label
                tone={
                  props.phone || props.current === item()[0]
                    ? "ink"
                    : "mutedInk"
                }
              >
                {text(item()[2])}
              </Label>
              <If when={props.phone}>
                <View style={{ flex: 1 }} />
                <View style={{ ...row, gap: space[4] }}>
                  <If when={props.summary(item()[0]).tone}>
                    <StatusDot color={c()[props.summary(item()[0]).tone!]} />
                  </If>
                  <Label variant="small" tone={summaryTone(item()[0])}>
                    {props.summary(item()[0]).text}
                  </Label>
                </View>
                <Icon name="right" tone="muted" size={icon.md} />
              </If>
            </View>
          )}
        </Each>
      </View>
    </SmoothScroll>
  );
}
