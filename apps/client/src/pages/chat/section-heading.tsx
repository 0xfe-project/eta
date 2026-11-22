import type { JSX } from "nsh";
import { View } from "nsh";
import { Button, Caption, Label, row } from "../../components";
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
        gap: 6,
        minHeight: 32,
        paddingTop: 6,
        paddingBottom: 2,
        paddingHorizontal: 12,
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
      size={props.phone ? 32 : 24}
      style={{ marginRight: -8 }}
      onPress={props.onPress}
    />
  );
}
