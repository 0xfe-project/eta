import type { SettingsSection, useSettingsOverview } from "./overview";
import { Scroll, View } from "nsh";
import { colors, grow, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";

import { useText } from "../../i18n";
import { sections } from "./overview";
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
  return (
    <Scroll
      style={
        props.phone
          ? grow
          : {
              width: 158,
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
            }
      }
      scrollbar={false}
    >
      <View style={{ padding: props.phone ? 0 : 6, gap: props.phone ? 0 : 2 }}>
        <Each of={sections}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={text(item()[2])}
              onPress={() => props.onSelect(item()[0])}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: props.phone ? 48 : 30,
                paddingHorizontal: props.phone ? 16 : 10,
                gap: props.phone ? 12 : 10,
                borderBottomWidth: props.phone ? 1 : 0,
                borderColor: c().border,
                backgroundColor:
                  props.current === item()[0] ? c().selected : c().canvas,
                cursor: "pointer",
              }}
            >
              <Icon
                name={item()[1]}
                size={16}
                tone={
                  !props.phone && props.current === item()[0] ? "ink" : "muted"
                }
              />
              <Label
                line={20}
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
                <View style={{ ...row, gap: 6 }}>
                  <If when={props.summary(item()[0]).tone}>
                    <StatusDot
                      color={c()[props.summary(item()[0]).tone!]}
                      size={6}
                    />
                  </If>
                  <Label size={12} line={16} tone={summaryTone(item()[0])}>
                    {props.summary(item()[0]).text}
                  </Label>
                </View>
                <Icon name="right" tone="muted" size={16} />
              </If>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}
