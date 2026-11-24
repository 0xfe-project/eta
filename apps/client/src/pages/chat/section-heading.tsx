import type { JSX } from "nsh";
import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { control, sizes, space } from "../../components/tokens";
import { uiText } from "../../i18n";

/** A Context-tab section's heading: its name, and whatever it offers at the right end. */
export function SectionHeading(props: {
  label: string;
  count?: number;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        height: sizes.sectionHeader,
        paddingHorizontal: space[12],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label variant="small" tone="muted">
        {props.count !== undefined
          ? `${props.label} ${props.count}`
          : props.label}
      </Label>
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
      size={props.phone ? control.lg : undefined}
      onPress={props.onPress}
    />
  );
}
