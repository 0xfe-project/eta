import type { JSX } from "nsh";
import { View } from "nsh";
import { Button, Caption, Label, row } from "../../components";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";

/** A Context-tab section's heading: its name, and whatever it offers at the right end. */
export function SectionHeading(props: {
  label: string;
  count?: number;
  children?: JSX.Element;
}) {
  return (
    <View
      style={{
        ...row,
        gap: space[4],
        minHeight: space[32],
        paddingTop: space[8],
        paddingBottom: space[2],
        paddingHorizontal: space[12],
      }}
    >
      <Caption text={props.label} />
      <If when={props.count !== undefined}>
        <Label variant="caption" tone="muted">
          {props.count}
        </Label>
      </If>
      <View style={{ flex: 1 }} />
      {props.children}
    </View>
  );
}

/**
 * "View all" at the right end of a section heading, to the tab or page that lists everything.
 * `label` says what it opens, since two of them can sit in one panel.
 */
export function ViewAll(props: {
  label: string;
  phone?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      label={uiText("viewAll")}
      accessibilityLabel={props.label}
      tone="ghost"
      labelTone="muted"
      labelVariant="caption"
      size={props.phone ? control.lg : control.sm}
      style={{ marginRight: -space[8] }}
      onPress={props.onPress}
    />
  );
}
