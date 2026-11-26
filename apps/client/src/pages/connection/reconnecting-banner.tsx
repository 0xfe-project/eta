import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { control, layer, shadow, space } from "../../components/tokens";
import { uiText } from "../../i18n";
/**
 * The strip that says the connection is down, over the top of the workspace (#380): it covers
 * what is under it for as long as it is there, and moves nothing in or out of place.
 */
export function ReconnectingBanner(props: {
  phone: boolean;
  onConnect: () => void;
}) {
  const c = colors();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: layer.sticky,
        boxShadow: [shadow.float],
        ...row,
        paddingVertical: props.phone ? space[12] : space[8],
        paddingHorizontal: space[16],
        gap: space[8],
        backgroundColor: c().selected,
        borderBottomWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <If when={!props.phone}>
        <StatusDot color={c().warning} />
      </If>
      <Label variant="small" style={{ flex: 1 }}>
        {props.phone
          ? uiText("connectionLostReconnectingWhatYouSee")
          : uiText("connectionLostReconnecting")}
      </Label>
      <If when={!props.phone}>
        {/* Not in the design; kept so the host
            can be changed without waiting for the Lost dialog. Drawn over
            the 16px text line so the strip keeps the design's height. */}
        <Button
          label={uiText("changeHost")}
          size={control.sm}
          style={{ marginVertical: -space[4] }}
          onPress={props.onConnect}
        />
      </If>
    </View>
  );
}
