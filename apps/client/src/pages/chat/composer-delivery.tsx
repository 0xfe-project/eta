import { View } from "nsh";
import { colors, focusRing, Label, row } from "../../components";
import { opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";

/** What can be done with a message the host did not take. */
export interface DeliveryActions {
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}

/**
 * The line under a message on its way, where its time goes once it is sent: `Sending…`, or why it
 * was not sent with Retry, Edit and Discard after it. One line while it sends, so the row keeps its
 * height when the host's row takes its place.
 */
export function DeliveryLine(
  props: {
    failure?: string;
    phone: boolean;
    /** Said while it sends, `Sending…` when not given. */
    sending?: string;
    /** Where the line sits: under a bubble (end) or a queued block (start). */
    align?: "start" | "end";
  } & DeliveryActions,
) {
  const c = colors();
  const link = (label: string, press: () => void) => (
    <View
      role="button"
      accessibilityLabel={label}
      onPress={press}
      hoverStyle={{ opacity: opacity.muted }}
      focusVisibleStyle={focusRing(c())}
      style={{
        paddingVertical: props.phone ? space[8] : 0,
        paddingHorizontal: props.phone ? space[4] : 0,
        cursor: "pointer",
      }}
    >
      <Label
        variant="caption"
        tone="ink"
        style={{ textDecorationLine: "underline" }}
      >
        {label}
      </Label>
    </View>
  );
  return (
    <If
      when={props.failure}
      else={
        <Label variant="caption" tone={props.phone ? "muted" : "faint"}>
          {props.sending ?? uiText("sendingMessage")}
        </Label>
      }
    >
      {(failure) => (
        <View
          role="alert"
          style={{
            ...row,
            flexWrap: "wrap",
            justifyContent: props.align === "start" ? "flex-start" : "flex-end",
            columnGap: props.phone ? space[4] : space[8],
            rowGap: space[2],
          }}
        >
          <Label variant="caption" tone="red">
            {uiText("sendFailed", { reason: failure() })}
          </Label>
          {link(uiText("retry"), props.onRetry)}
          {link(uiText("edit"), props.onEdit)}
          {link(uiText("discard"), props.onDiscard)}
        </View>
      )}
    </If>
  );
}
